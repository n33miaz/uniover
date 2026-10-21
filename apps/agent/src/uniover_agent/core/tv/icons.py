"""Ícones dos apps da TV: achar no APK, guardar em cache por versão e publicar em `tv.apps.v2`.

Duas peças:

* `IconResolver`: para um app, devolve o ícone (do cache, ou trazendo o APK da TV, perguntando ao
  `aapt2` e lendo só o arquivo de imagem de dentro do ZIP). Guarda o resultado por versão do app,
  inclusive o "esta versão não tem ícone útil", para não baixar dezenas de MB à toa. Só publica
  imagem **quadrada**: o banner 16:9 da TV nunca vira ícone, e um app sem imagem quadrada fica
  sem ícone (a tela mostra a inicial) em vez de ganhar um azulejo largo;
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
from dataclasses import dataclass
from pathlib import Path
from typing import Final, Protocol

from uniover_agent.core.domain import TvState
from uniover_agent.core.envelopes import EnvelopeFactory, serialized_size
from uniover_agent.core.tv.apps import AppEntry
from uniover_agent.core.tv.icon_badging import (
    MAX_ICON_BYTES,
    PREFERRED_MAX_SIDE,
    image_info,
    parse_badging,
)
from uniover_agent.core.tv.icon_resources import parse_icon_fallbacks
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
_SPLIT_NAME: Final = re.compile(r"/split_[^/]*\.apk$")
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
    """O ícone se os bytes são PNG/WebP **quadrado** de verdade e cabem no limite do contrato.

    Também vale para o que sai do cache: um banner guardado antes da regra do quadrado não passa.
    """
    if not data or len(data) > MAX_ICON_BYTES:
        return None
    info = image_info(data)
    return AppIcon(info.mime, data) if info is not None and info.is_square else None


def _density_splits(paths: Sequence[str]) -> list[str]:
    found: list[tuple[int, str]] = []
    for path in paths:
        match = _DENSITY_SPLIT.search(path)
        if match and match.group("density") in _DENSITY_RANK:
            found.append((_DENSITY_RANK[match.group("density")], path))
    return [path for _, path in sorted(found)]


def _split_paths(paths: Sequence[str]) -> tuple[str, list[str]]:
    """O APK principal (`base.apk`) e os demais.

    Sem `base.apk` (app de sistema, por exemplo), vale o primeiro que não seja `split_*.apk`: o
    ícone fica sempre no principal, nunca num APK de idioma.
    """
    main = next((path for path in paths if path.endswith("/base.apk")), None)
    if main is None:
        main = next((path for path in paths if not _SPLIT_NAME.search(path)), paths[0])
    return main, [path for path in paths if path != main]


@dataclass(frozen=True, slots=True)
class _Square:
    """Uma imagem quadrada aceita: o lado em pixels e o arquivo de onde veio (para o registro)."""

    icon: AppIcon
    side: int
    name: str


def _pick(found: Sequence[_Square]) -> _Square | None:
    """A maior imagem de até `PREFERRED_MAX_SIDE` px; se todas passam disso, a menor delas.

    Sem biblioteca de imagem não há como reduzir, então o tamanho padronizado vem da escolha: o
    ícone fica nítido e leve, sem passar do necessário. Empate no lado vale a primeira da lista
    (a de maior densidade).
    """
    small = [item for item in found if item.side <= PREFERRED_MAX_SIDE]
    if small:
        return max(small, key=lambda item: item.side)
    return min(found, key=lambda item: item.side, default=None)


@dataclass(slots=True)
class _Tally:
    """O que foi tentado em um app, para explicar no registro por que ficou sem ícone."""

    tried: int = 0
    absent: int = 0  # fora do APK, ou acima do limite de tamanho
    unusable: int = 0  # não é PNG/WebP legível
    non_square: int = 0  # imagem de verdade, mas largura diferente da altura (banner)
    adaptive: bool = False  # o app declara o ícone em XML adaptativo

    def reason(self) -> str:
        """Texto fixo: nunca o conteúdo da imagem nem caminho do computador."""
        if self.non_square:
            return f"só há imagem não quadrada ({self.non_square} de {self.tried} testadas)"
        if self.tried == 0:
            if self.adaptive:
                return "ícone adaptativo (XML) sem imagem PNG/WebP de reserva"
            return "o APK não declara imagem PNG/WebP de ícone"
        if self.absent:
            return "as imagens de ícone não estão no APK ou passam do limite de tamanho"
        return "nenhuma imagem de ícone legível"


@dataclass(frozen=True, slots=True)
class _Look:
    """Resultado de olhar um APK: o ícone achado (ou não), os nomes tentados e a versão."""

    square: _Square | None
    candidates: tuple[str, ...]
    version: int | None


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
        tally = _Tally()
        square, badging_version = await self._icon_from(paths, tally)
        icon = None if square is None else square.icon
        if square is None:
            _log.info("app %s ficou sem ícone: %s", package, tally.reason())
        else:
            _log.debug(
                "ícone de %s: %s, %dx%d, %d bytes",
                package,
                square.name,
                square.side,
                square.side,
                len(square.icon.data),
            )
        effective = version if version is not None else badging_version
        if effective is not None:
            self._cache.store(package, effective, icon)
        return icon

    async def _icon_from(
        self, paths: Sequence[str], tally: _Tally
    ) -> tuple[_Square | None, int | None]:
        main, others = _split_paths(paths)
        first = await self._look_in(main, None, tally)
        if first.square is not None or not first.candidates:
            return first.square, first.version
        # O principal não tinha imagem utilizável: os PNG podem estar no APK da densidade.
        for split in _density_splits(others):
            look = await self._look_in(split, first.candidates, tally)
            if look.square is not None:
                return look.square, first.version
        return None, first.version

    async def _look_in(self, remote: str, known: Sequence[str] | None, tally: _Tally) -> _Look:
        """Copia o APK, lê os candidatos (os do `badging` ou os já conhecidos) e apaga a cópia."""
        local = self._scratch.new_path()
        try:
            await self._source.pull_apk(remote, local)
            if known is not None:
                return _Look(_pick(await self._scan(local, known, tally)), tuple(known), None)
            info = parse_badging(await self._inspector.dump_badging(local))
            tally.adaptive = bool(info.adaptive)
            candidates = list(info.candidates)
            found = await self._scan(local, candidates, tally)
            if not found and info.adaptive:
                # Ícone adaptativo (XML): a imagem quadrada de reserva só consta nos recursos.
                table = await self._inspector.dump_resources(local)
                fallbacks = [
                    name
                    for name in parse_icon_fallbacks(table, info.adaptive)
                    if name not in candidates
                ]
                candidates.extend(fallbacks)
                found = await self._scan(local, fallbacks, tally)
            return _Look(_pick(found), tuple(candidates), info.version_code)
        finally:
            self._scratch.discard(local)

    async def _scan(self, apk: Path, names: Sequence[str], tally: _Tally) -> list[_Square]:
        """Lê cada candidato e fica só com as imagens quadradas que cabem no limite."""
        found: list[_Square] = []
        for name in names:
            tally.tried += 1
            data = await self._inspector.read_member(apk, name, MAX_ICON_BYTES)
            if data is None or len(data) > MAX_ICON_BYTES:
                tally.absent += 1
                continue
            info = image_info(data)
            if info is None:
                tally.unusable += 1
            elif not info.is_square:
                tally.non_square += 1
            else:
                found.append(_Square(AppIcon(info.mime, data), info.width, name))
        return found


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
