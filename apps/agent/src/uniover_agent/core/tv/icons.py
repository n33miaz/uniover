"""Ícones dos apps da TV: achar no APK, guardar em cache por versão e publicar em `tv.apps.v2`.

Duas peças:

* `IconResolver`: para um app, devolve o ícone (do cache, ou trazendo o APK da TV, perguntando ao
  `aapt2` e lendo só o arquivo de imagem de dentro do ZIP). Guarda o resultado por versão do app,
  inclusive o "esta versão não tem ícone útil", para não baixar dezenas de MB à toa;
* `AppIconPublisher`: tarefa de fundo, um APK por vez, que publica os ícones **depois** da lista
  sem ícones (`tv.apps.v1`). A cópia do APK não passa pela trava dos comandos curtos do ADB, então
  uma tecla ou um texto digitado nunca esperam um download.

O transporte com a API recusa (fechando a conexão) mensagem acima de 64 KB. Por isso cada
`tv.apps.v2` leva a lista completa, mas só o tanto de ícones que cabe no orçamento de bytes; o
resto vai em mensagens seguintes. App sem ícone na mensagem quer dizer "mantenha o que já tem".
"""

import asyncio
import hashlib
import logging
import re
from collections.abc import Awaitable, Callable, Sequence
from typing import Final, Protocol

from uniover_agent.core.domain import TvState
from uniover_agent.core.envelopes import EnvelopeFactory, serialized_size
from uniover_agent.core.tv.apps import AppEntry
from uniover_agent.core.tv.icon_badging import MAX_ICON_BYTES, detect_mime, parse_badging
from uniover_agent.ports import (
    AdbError,
    AdbNotReady,
    ApkInspector,
    ApkScratch,
    ApkSource,
    AppIcon,
    CachedIcon,
    IconCache,
    IconToolError,
    Transport,
    TransportError,
)

_log = logging.getLogger(__name__)

# Abaixo do limite de 64 KB do servidor, com folga para o envelope e variações de serialização.
MAX_ENVELOPE_BYTES: Final = 60_000
# Respiro entre um APK e o seguinte: deixa passar o que for interativo e poupa a TV (48 MB livres).
PAUSE_BETWEEN_APKS_SECONDS: Final = 0.5
# `,"icon":{"mime":"image/webp","data":""}` sem os dados: folga fixa por ícone no cálculo do pacote.
_ICON_FRAMING_BYTES: Final = 48
# APKs de configuração por densidade (onde os PNG de alta resolução costumam ficar).
_DENSITY_SPLIT: Final = re.compile(r"/split_config\.(?P<density>[a-z]*dpi)\.apk$")
_DENSITY_RANK: Final = {
    "xxxhdpi": 0,
    "xxhdpi": 1,
    "xhdpi": 2,
    "tvdpi": 3,
    "hdpi": 4,
    "mdpi": 5,
    "ldpi": 6,
}


def validate_icon(data: bytes | None) -> AppIcon | None:
    """O ícone se os bytes são PNG/WebP de verdade e cabem no limite do contrato; senão `None`."""
    if not data or len(data) > MAX_ICON_BYTES:
        return None
    mime = detect_mime(data)
    return AppIcon(mime, data) if mime else None


def _density_splits(paths: Sequence[str]) -> list[str]:
    found: list[tuple[int, str]] = []
    for path in paths:
        match = _DENSITY_SPLIT.search(path)
        if match and match.group("density") in _DENSITY_RANK:
            found.append((_DENSITY_RANK[match.group("density")], path))
    return [path for _, path in sorted(found)]


class IconResolver:
    """Descobre o ícone de um app. Um app por vez; quem chama decide o ritmo."""

    def __init__(
        self,
        source: ApkSource,
        inspector: ApkInspector,
        cache: IconCache,
        scratch: ApkScratch,
    ) -> None:
        self._source = source
        self._inspector = inspector
        self._cache = cache
        self._scratch = scratch

    def cached(self, package: str, version: int) -> CachedIcon | None:
        """O que há em cache para esta versão, conferido de novo (o arquivo pode ter mudado)."""
        entry = self._cache.load(package, version)
        if entry is None or entry.icon is None:
            return entry
        checked = validate_icon(entry.icon.data)
        # Entrada estragada vale como "nunca baixado": será refeita e sobrescrita.
        return None if checked is None else CachedIcon(checked)

    async def resolve(self, package: str, version: int | None) -> AppIcon | None:
        """Traz o APK, lê o ícone e guarda em cache. `None` quando o app não tem ícone utilizável.

        Levanta `AdbError` (a TV não entregou) ou `IconToolError` (APK ou `aapt2` com
        defeito). Nesses casos nada é guardado, para que a próxima atualização tente de novo.
        """
        paths = await self._source.apk_paths(package)
        if not paths:
            return None
        icon, badging_version = await self._icon_from(paths)
        effective = version if version is not None else badging_version
        if effective is not None:
            self._cache.store(package, effective, icon)
        return icon

    async def _icon_from(self, paths: Sequence[str]) -> tuple[AppIcon | None, int | None]:
        base_icon, candidates, version = await self._look_in(paths[0], None)
        if base_icon is not None or not candidates:
            return base_icon, version
        # O base não tinha imagem utilizável: os PNG podem estar no APK da densidade.
        for split in _density_splits(paths[1:]):
            icon, _, _ = await self._look_in(split, candidates)
            if icon is not None:
                return icon, version
        return None, version

    async def _look_in(
        self, remote: str, known: Sequence[str] | None
    ) -> tuple[AppIcon | None, tuple[str, ...], int | None]:
        """Copia o APK, lê os candidatos (os do `badging` ou os já conhecidos) e apaga a cópia."""
        local = self._scratch.new_path()
        try:
            await self._source.pull_apk(remote, local)
            candidates: tuple[str, ...]
            version: int | None = None
            if known is None:
                info = parse_badging(await self._inspector.dump_badging(local))
                candidates, version = info.candidates, info.version_code
            else:
                candidates = tuple(known)
            for name in candidates:
                icon = validate_icon(await self._inspector.read_member(local, name, MAX_ICON_BYTES))
                if icon is not None:
                    return icon, candidates, version
            return None, candidates, version
        finally:
            self._scratch.discard(local)


class IconRequests(Protocol):
    """O que a publicação da lista pede ao publicador de ícones."""

    def request(self, apps: Sequence[AppEntry]) -> None: ...


def _fingerprint(icon: AppIcon) -> str:
    return hashlib.sha256(icon.data).hexdigest()


class AppIconPublisher:
    """Publica `tv.apps.v2` em tarefa de fundo, com os ícones que forem ficando prontos."""

    def __init__(  # noqa: PLR0913, PLR0917 - dependências independentes, todas injetadas
        self,
        resolver: IconResolver,
        source: ApkSource,
        transport: Transport,
        envelopes: EnvelopeFactory,
        is_hot: Callable[[], bool],
        sleep: Callable[[float], Awaitable[None]],
        pause: float = PAUSE_BETWEEN_APKS_SECONDS,
    ) -> None:
        self._resolver = resolver
        self._source = source
        self._transport = transport
        self._envelopes = envelopes
        self._is_hot = is_hot
        self._sleep = sleep
        self._pause = pause
        self._latest: list[AppEntry] = []
        self._sent: dict[str, str] = {}
        self._trigger = asyncio.Event()
        self._dirty = False
        self._unfinished = False

    def request(self, apps: Sequence[AppEntry]) -> None:
        """Nova lista publicada (`tv.apps.v1`): os ícones chegam de novo (do cache, se der).

        Só marca e acorda a tarefa de fundo; nunca espera TV nem rede.
        """
        self._latest = list(apps)
        self._sent.clear()
        self._dirty = True
        self._trigger.set()

    def on_state(self, state: TvState) -> None:
        """Sessão voltou a ficar quente: retoma o que ficou pela metade (e só isso)."""
        if state.connection == "hot" and self._unfinished and self._latest:
            self._trigger.set()

    async def run(self) -> None:
        while True:
            await self._trigger.wait()
            self._trigger.clear()
            self._dirty = False
            try:
                await self._pass()
            except Exception:
                # Nada aqui derruba o agente; o próximo pedido tenta de novo.
                self._unfinished = True
                _log.exception("falha ao obter os ícones dos apps da TV")

    async def _pass(self) -> None:
        apps = self._latest
        if not apps:
            return
        self._unfinished = False
        try:
            versions = await self._source.package_versions()
        except AdbError as exc:
            _log.info("versões dos apps não obtidas (%s); ícones ficam para depois", exc.code)
            self._unfinished = True
            return

        ready: list[tuple[str, AppIcon]] = []
        misses: list[tuple[AppEntry, int | None]] = []
        for app in apps:
            version = versions.get(app.package)
            entry = self._resolver.cached(app.package, version) if version is not None else None
            if entry is None:
                misses.append((app, version))
            elif entry.icon is not None:
                ready.append((app.package, entry.icon))
        # Primeiro o que já está em cache: a tela ganha ícones sem esperar nenhum download.
        await self._publish(apps, ready)

        for app, version in misses:
            if self._dirty:
                return  # lista nova pedida no meio: o laço recomeça com ela
            if not self._is_hot():
                self._unfinished = True
                return
            await self._sleep(self._pause)
            try:
                icon = await self._resolver.resolve(app.package, version)
            except AdbNotReady as exc:
                _log.info("TV sem resposta ao buscar ícones (%s); retomo depois", exc.code)
                self._unfinished = True
                return
            except (AdbError, IconToolError, ValueError, OSError) as exc:
                # Um app que falha não impede os outros; ele tenta de novo na próxima lista.
                _log.warning(
                    "ícone de %s não obtido (%s)",
                    app.package,
                    getattr(exc, "code", type(exc).__name__),
                )
                self._unfinished = True
                continue
            if icon is not None:
                await self._publish(apps, [(app.package, icon)])

    async def _publish(self, apps: list[AppEntry], ready: list[tuple[str, AppIcon]]) -> None:
        """Envia os ícones ainda não enviados, em quantas mensagens o orçamento de bytes exigir."""
        pending = [(p, i) for p, i in ready if self._sent.get(p) != _fingerprint(i)]
        while pending:
            chunk = self._pack(apps, pending)
            if not chunk:
                # Nem um ícone cabe: descarta o primeiro e segue (não ocorre com o limite de 32 KB).
                _log.warning("ícone de %s grande demais para a mensagem; ignorado", pending[0][0])
                pending = pending[1:]
                continue
            icons = dict(chunk)
            envelope = self._envelopes.tv_apps_v2(
                [(a.package, a.label, icons.get(a.package)) for a in apps]
            )
            try:
                await self._transport.send(envelope)
            except TransportError as exc:
                # Sem conexão: na reconexão a lista é republicada e os ícones vêm de novo.
                _log.debug("ícones não enviados (%s)", exc)
                return
            for package, icon in chunk:
                self._sent[package] = _fingerprint(icon)
            pending = pending[len(chunk) :]

    def _pack(
        self, apps: list[AppEntry], pending: list[tuple[str, AppIcon]]
    ) -> list[tuple[str, AppIcon]]:
        """Tantos ícones, na ordem, quantos cabem em `MAX_ENVELOPE_BYTES` (o real é medido)."""
        base = serialized_size(
            self._envelopes.tv_apps_v2([(a.package, a.label, None) for a in apps])
        )
        chunk: list[tuple[str, AppIcon]] = []
        total = base
        for package, icon in pending:
            cost = ((len(icon.data) + 2) // 3) * 4 + len(icon.mime) + _ICON_FRAMING_BYTES
            if total + cost > MAX_ENVELOPE_BYTES:
                break
            chunk.append((package, icon))
            total += cost
        # A estimativa tem folga, mas a regra é o tamanho real: tira ícones até caber.
        while chunk:
            icons = dict(chunk)
            real = serialized_size(
                self._envelopes.tv_apps_v2(
                    [(a.package, a.label, icons.get(a.package)) for a in apps]
                )
            )
            if real <= MAX_ENVELOPE_BYTES:
                break
            chunk.pop()
        return chunk
