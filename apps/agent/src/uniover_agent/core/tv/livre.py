"""TV Livre: instalar o launcher próprio da TV, defini-lo como padrão e voltar ao original.

Tudo é opt-in e reversível, e a ordem dos passos é o que impede a TV de ficar sem tela inicial
(`apps/tv-launcher/README.md` tem a mesma sequência, com os comandos):

- **Instalar** captura o launcher de fábrica e ensaia a volta (`set-home-activity` precisa
  responder `Success`) ANTES de tocar em qualquer coisa; só então instala e abre o app uma vez.
- **Definir como padrão** só vale depois de verificar que a home nova virou o padrão; qualquer
  falha devolve o original. O launcher de fábrica só é desativado (opcional) depois da conferência.
- **Voltar ao original** é o caminho inverso: reabilita, define o original, verifica, e só então
  desinstala. Sem a verificação, nada é desinstalado.

O estado anterior (launcher de fábrica e o que foi desativado) é gravado em disco ANTES de cada
passo que muda a TV, para que uma queda do agente no meio ainda deixe a volta possível. Nenhum
texto livre chega ao shell da TV: os comandos são fixos e o nome de pacote é validado.
"""

import asyncio
import base64
import hashlib
import io
import json
import logging
import re
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Final

from PIL import Image, UnidentifiedImageError

from uniover_agent.core.domain import Command, CommandResult, ResultStatus
from uniover_agent.core.envelopes import EnvelopeFactory
from uniover_agent.core.handle_command import Handler
from uniover_agent.core.tv.cleanup import PROTECTED_PACKAGES, PROTECTED_PREFIXES
from uniover_agent.core.tv.livre_config import (
    InvalidConfigError,
    build_launcher_config,
    is_valid_package_name,
)
from uniover_agent.ports import AdbError, Clock, Transport, TransportError
from uniover_agent.ports.tv_livre import LauncherApkError, LauncherApkSource, TvLivreAdb

_log = logging.getLogger(__name__)

CAPABILITY: Final = "tv.livre.v1"
PACKAGE: Final = "br.uniover.launcher"
HOME_COMPONENT: Final = f"{PACKAGE}/.HomeActivity"
SLEEP_COMPONENT: Final = f"{PACKAGE}/.SleepActivity"
FILES_DIR: Final = f"/sdcard/Android/data/{PACKAGE}/files"
MIN_SDK: Final = 28
MAX_PHOTO_BYTES: Final = 400 * 1024
PHOTO_TTL_SECONDS: Final = 600.0
MAX_STATE_APPS: Final = 300
MAX_PHOTO_SIDE: Final = 4096
AUDIT_LIMIT: Final = 50
SEND_FAILED: Final = "send_failed"
STARTUP_WAIT_SECONDS: Final = 1.5

_COMPONENT: Final = re.compile(
    r"[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+/\.?[A-Za-z0-9_.$]+"
)
_VERSION_NAME: Final = re.compile(r"versionName=(\S{1,40})")
_DIGITS: Final = re.compile(r"\d{1,3}")
_PID: Final = re.compile(r"\d+")
_OWNER_OF_COMPONENT: Final = re.compile(r"([A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+)/")
_MAIN: Final = "-a android.intent.action.MAIN"
_HOME_CATEGORY: Final = "-c android.intent.category.HOME"
_RESOLVE_HOME: Final = f"cmd package resolve-activity --brief {_MAIN} {_HOME_CATEGORY}"
_QUERY_HOME: Final = f"cmd package query-activities --brief {_MAIN} {_HOME_CATEGORY}"
_OPEN_LAUNCHER: Final = f"am start -n {HOME_COMPONENT}"
_BROADCAST: Final = (
    f"am broadcast -n {PACKAGE}/.ConfigReceiver -a {PACKAGE}.action.APPLY_CONFIG --es config_b64 "
)

# Além dos pacotes que o fechamento de apps já protege: peças sem as quais instalar, conceder
# permissão ou parear um controle Bluetooth deixa de funcionar.
EXTRA_PROTECTED: Final = frozenset(
    {
        "com.android.shell",
        "com.android.packageinstaller",
        "com.google.android.packageinstaller",
        "com.android.permissioncontroller",
        "com.google.android.permissioncontroller",
        "com.android.keychain",
        "com.android.certinstaller",
        "com.android.inputdevices",
    }
)
PROTECTED_DISABLE_PREFIXES: Final = (*PROTECTED_PREFIXES, "com.android.bluetooth")
PROTECTED_DISABLE_FRAGMENTS: Final = ("remote",)


class LivreError(Exception):
    """Falha do módulo. `code` é estável (vai à API); `message` é seguro para a tela do dono."""

    def __init__(self, code: str, message: str, *, rejected: bool = False) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        # Recusa por regra (pedido que não deve ser repetido igual), em vez de falha do aparelho.
        self.rejected = rejected


@dataclass(frozen=True, slots=True)
class LivreApp:
    package: str
    factory: bool
    disabled: bool


@dataclass(frozen=True, slots=True)
class LivreState:
    """Corpo de `tv.livre.state.v1` (sem o `requestId` e o horário, que a mensagem acrescenta)."""

    supported: bool
    sdk: int | None
    installed: bool
    version: str | None
    is_home: bool
    factory_launcher: str | None
    disabled_packages: tuple[str, ...]
    apps: tuple[LivreApp, ...]


def _package_of(component: str) -> str:
    return component.split("/", 1)[0]


def _components(text: str) -> list[str]:
    """Os componentes `pacote/Atividade` de uma saída, na ordem e sem repetir."""
    found: list[str] = []
    for line in text.splitlines():
        candidate = line.strip()
        if _COMPONENT.fullmatch(candidate) and candidate not in found:
            found.append(candidate)
    return found


def is_protected_for_disable(package: str, live: frozenset[str]) -> bool:
    """Pacote que `pm disable-user` nunca toca. `live` são os lidos da TV agora.

    Regra própria (e não a do fechamento de apps): aquela protege tudo que não é "app de uso",
    o que recusaria justamente os apps de fábrica que o dono quer desativar.
    """
    if package in live or package in PROTECTED_PACKAGES or package in EXTRA_PROTECTED:
        return True
    lowered = package.lower()
    return lowered.startswith(PROTECTED_DISABLE_PREFIXES) or any(
        fragment in lowered for fragment in PROTECTED_DISABLE_FRAGMENTS
    )


def is_decodable_jpeg(photo: bytes) -> bool:
    """JPEG de verdade: o cabeçalho diz JPEG com lados razoáveis e a imagem inteira decodifica.

    Três bytes iniciais não bastam: um arquivo truncado ou corrompido chegaria à TV e o launcher
    cairia para o degradê sem ninguém saber por quê.
    """
    try:
        with Image.open(io.BytesIO(photo)) as image:
            width, height = image.size
            if image.format != "JPEG" or not (
                0 < width <= MAX_PHOTO_SIDE and 0 < height <= MAX_PHOTO_SIDE
            ):
                return False
            image.load()
    except UnidentifiedImageError, OSError, SyntaxError, ValueError:
        return False
    return True


class PhotoStaging:
    """Junta os pedaços da foto do fundo e a guarda, na memória, até o `apply` que a cita."""

    def __init__(self, clock: Clock) -> None:
        self._clock = clock
        self._photo_id: str | None = None
        self._parts: dict[int, bytes] = {}
        self._ready: bytes | None = None
        self._since = 0.0

    def add(self, photo_id: str, index: int, total: int, sha256: str, data: str) -> None:
        """Guarda um pedaço; ao completar, confere tamanho, JPEG e hash (senão `LivreError`)."""
        now = self._clock.monotonic()
        if photo_id != self._photo_id or now - self._since > PHOTO_TTL_SECONDS:
            self._photo_id, self._parts, self._ready, self._since = photo_id, {}, None, now
        try:
            self._parts[index] = base64.b64decode(data, validate=True)
        except ValueError:
            self._reset()
            raise LivreError("invalid_photo", "A foto veio corrompida.", rejected=True) from None
        if len(self._parts) < total:
            return
        photo = b"".join(self._parts[i] for i in range(total) if i in self._parts)
        valid = (
            len(self._parts) == total
            and 0 < len(photo) <= MAX_PHOTO_BYTES
            and is_decodable_jpeg(photo)
            and hashlib.sha256(photo).hexdigest() == sha256
        )
        if not valid:
            self._reset()
            raise LivreError("invalid_photo", "A foto veio corrompida.", rejected=True)
        self._ready = photo

    def take(self, photo_id: str) -> bytes | None:
        if (
            self._ready is None
            or photo_id != self._photo_id
            or self._clock.monotonic() - self._since > PHOTO_TTL_SECONDS
        ):
            return None
        return self._ready

    def _reset(self) -> None:
        self._photo_id, self._parts, self._ready = None, {}, None


class LivreStateFile:
    """O que precisa sobreviver a uma queda do agente: o original e o que foi desativado."""

    def __init__(self, path: Path) -> None:
        self._path = path

    def load(self) -> dict[str, Any]:
        try:
            data = json.loads(self._path.read_text(encoding="utf-8"))
        except OSError, ValueError:
            return {}
        return data if isinstance(data, dict) else {}

    def save(self, data: dict[str, Any]) -> None:
        self._path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self._path.with_suffix(".tmp")
        temporary.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        temporary.replace(self._path)

    def delete(self) -> None:
        self._path.unlink(missing_ok=True)


class TvLivre:
    """Os passos do TV Livre sobre o canal ADB; um por vez."""

    def __init__(
        self,
        adb: TvLivreAdb,
        apk: LauncherApkSource,
        state: LivreStateFile,
        photos: PhotoStaging,
        clock: Clock,
    ) -> None:
        self._adb = adb
        self._apk = apk
        self._state = state
        self._photos = photos
        self._clock = clock
        self._lock = asyncio.Lock()

    # --- leitura ------------------------------------------------------------------------------

    async def read_state(self) -> LivreState:
        async with self._lock:
            return await self._read_state()

    async def _read_state(self) -> LivreState:
        sdk = await self._sdk()
        leanback = "android.software.leanback" in (await self._adb.shell("pm list features")).text
        if sdk is None or sdk < MIN_SDK or not leanback:
            return LivreState(False, sdk, False, None, False, None, (), ())
        stored = self._state.load()
        installed = "package:" in (await self._adb.shell(f"pm path {PACKAGE}")).text
        version = None
        if installed:
            match = _VERSION_NAME.search((await self._adb.shell(f"dumpsys package {PACKAGE}")).text)
            version = match.group(1) if match else None
        resolved = _components((await self._adb.shell(_RESOLVE_HOME)).text)
        is_home = bool(resolved) and _package_of(resolved[-1]) == PACKAGE
        ours: list[str] = [p for p in stored.get("disabled", []) if is_valid_package_name(p)]
        return LivreState(
            True,
            sdk,
            installed,
            version,
            is_home,
            stored.get("factory") if isinstance(stored.get("factory"), str) else None,
            tuple(ours),
            await self._apps(frozenset(ours)),
        )

    async def _sdk(self) -> int | None:
        # Algumas TVs imprimem linhas de ruído antes da resposta: vale a última linha só de dígitos.
        text = (await self._adb.shell("getprop ro.build.version.sdk")).text
        numbers = [line.strip() for line in text.splitlines() if _DIGITS.fullmatch(line.strip())]
        return int(numbers[-1]) if numbers else None

    async def _apps(self, disabled_by_us: frozenset[str]) -> tuple[LivreApp, ...]:
        launchable = [app.package for app in await self._adb.list_apps()]
        system = (await self._adb.shell("pm list packages -s -f")).text
        factory: set[str] = set()
        for line in system.splitlines():
            path, _, package = line.strip().removeprefix("package:").rpartition("=")
            if package and not path.startswith("/data/"):
                factory.add(package)
        disabled = {
            line.strip().removeprefix("package:")
            for line in (await self._adb.shell("pm list packages -d")).text.splitlines()
        }
        packages = [p for p in dict.fromkeys(launchable) if p != PACKAGE]
        packages += [p for p in sorted(disabled_by_us) if p not in packages]
        return tuple(
            LivreApp(package, package in factory, package in disabled)
            for package in packages[:MAX_STATE_APPS]
            if is_valid_package_name(package)
        )

    # --- passos -------------------------------------------------------------------------------

    async def run(self, body: dict[str, Any]) -> None:
        """Executa a ação do pedido. Levanta `LivreError`, `AdbError` ou `LauncherApkError`."""
        action = body.get("action")
        async with self._lock:
            if action == "status":
                # Só confirma que a TV responde; o estado sai da leitura que o handler faz depois.
                await self._sdk()
                return
            await self._require_supported()
            if action == "install":
                await self._install()
            elif action == "set-home":
                await self._set_home(body.get("disableFactory") is True)
            elif action == "restore":
                await self._restore(body.get("uninstall") is not False)
            elif action == "apply":
                await self._apply(body)
            elif action == "set-apps":
                await self._set_apps(body.get("disable") or [], body.get("enable") or [])
            elif action == "sleep":
                await self._sleep()
            else:
                raise LivreError("unknown_action", "Ação desconhecida.", rejected=True)

    async def _require_supported(self) -> None:
        state = await self._read_support()
        if not state:
            raise LivreError(
                "unsupported",
                "Esta TV não é Android TV ou Google TV (Android 9 ou mais).",
                rejected=True,
            )

    async def _read_support(self) -> bool:
        sdk = await self._sdk()
        if sdk is None or sdk < MIN_SDK:
            return False
        return "android.software.leanback" in (await self._adb.shell("pm list features")).text

    async def _require_installed(self) -> None:
        if "package:" not in (await self._adb.shell(f"pm path {PACKAGE}")).text:
            raise LivreError(
                "not_installed", "O TV Livre ainda não está instalado na TV.", rejected=True
            )

    async def _resolved_home(self) -> str | None:
        found = _components((await self._adb.shell(_RESOLVE_HOME)).text)
        return found[-1] if found else None

    async def _set_home_activity(self, component: str) -> bool:
        """`set-home-activity`, com a repetição `--user 0` que alguns sistemas pedem."""
        for command in (
            f"cmd package set-home-activity {component}",
            f"cmd package set-home-activity --user 0 {component}",
        ):
            result = await self._adb.shell(command)
            if "Success" in result.text:
                return True
        return False

    async def _capture_original(self) -> dict[str, Any]:
        """Guarda o launcher de fábrica depois de ensaiar a volta; sem isso nada avança."""
        stored = self._state.load()
        if isinstance(stored.get("factory"), str) and stored["factory"]:
            return stored
        candidates = [
            c
            for c in [
                *_components((await self._adb.shell(_RESOLVE_HOME)).text),
                *_components((await self._adb.shell(_QUERY_HOME)).text),
            ]
            if _package_of(c) != PACKAGE
        ]
        candidates = list(dict.fromkeys(candidates))
        for component in candidates:
            # Ensaio: reaplica o que já é o padrão e prova que o componente é um launcher.
            if await self._set_home_activity(component):
                stored.update({"factory": component, "candidates": candidates})
                stored.setdefault("disabled", [])
                self._state.save(stored)
                return stored
        raise LivreError(
            "no_factory_launcher",
            "Não achei o launcher de fábrica da TV para garantir a volta; nada foi alterado.",
            rejected=True,
        )

    async def _runs(self, command: str, package: str) -> bool:
        """Abre e confere que de fato abriu: `am start` sem erro E o processo do app vivo.

        Um APK que instala mas não inicia (ou cai ao abrir) passaria na verificação do gerenciador
        de pacotes; esta é a conferência de que a tela inicial realmente executa.
        """
        started = await self._adb.shell(command)
        if not started.ok or any(
            line.strip().startswith("Error") or "Exception" in line
            for line in started.text.splitlines()
        ):
            return False
        await self._clock.sleep(STARTUP_WAIT_SECONDS)
        alive = await self._adb.shell(f"pidof {package}")
        return any(_PID.fullmatch(token) for token in alive.text.split())

    async def _require_launcher_runs(self) -> None:
        if not await self._runs(_OPEN_LAUNCHER, PACKAGE):
            raise LivreError(
                "launcher_not_running",
                "O TV Livre instalou, mas não abriu na TV; nada foi alterado na tela inicial.",
            )

    async def _restore_home(self, component: str, *, enable: bool = False) -> None:
        """Tenta devolver a tela inicial anterior depois de uma troca que não pôde ser confirmada.

        A volta é melhor esforço: a falha original continua sendo a que vai para a API, mas abrir a
        activity explicitamente evita depender de como cada fabricante interpreta o intent HOME.
        """
        package = _package_of(component)
        if enable:
            await self._adb.shell(f"pm enable --user 0 {package}")
        await self._set_home_activity(component)
        await self._runs(f"am start -n {component}", package)

    async def _install(self) -> None:
        await self._capture_original()
        apk = await self._apk.fetch()
        result = await self._adb.install(apk.path)
        if "INSTALL_FAILED_UPDATE_INCOMPATIBLE" in result.text:
            raise LivreError(
                "signature_mismatch",
                "Há um TV Livre de outra assinatura: use Voltar ao Original e instale outra vez.",
            )
        if not result.ok or "Success" not in result.text:
            raise LivreError("install_failed", "A TV não aceitou a instalação.")
        # Abre uma vez: cria a pasta da configuração. O launcher de fábrica segue como padrão.
        await self._require_launcher_runs()

    async def _apply(self, body: dict[str, Any]) -> None:
        await self._require_installed()
        photo: bytes | None = None
        photo_id = body.get("photoId")
        if isinstance(photo_id, str):
            photo = self._photos.take(photo_id)
            if photo is None:
                raise LivreError(
                    "photo_missing", "A foto não chegou inteira; envie de novo.", rejected=True
                )
        revision = body.get("revision")
        try:
            config = build_launcher_config(
                str(body.get("configJson", "")),
                revision if isinstance(revision, int) else -1,
                photo=photo is not None,
            )
        except InvalidConfigError as exc:
            raise LivreError(
                "invalid_config", f"Configuração recusada ({exc}).", rejected=True
            ) from None
        text = json.dumps(config, ensure_ascii=False, separators=(",", ":"))
        if not await self._files_dir_ready():
            if photo is not None:
                raise LivreError(
                    "no_files_dir", "A TV não tem a pasta do app: a foto não foi enviada."
                )
            await self._broadcast(text)
        else:
            with tempfile.TemporaryDirectory(prefix="uniover-livre-") as scratch:
                if photo is not None:
                    await self._push_atomic(Path(scratch), "wallpaper.jpg", photo)
                await self._push_atomic(Path(scratch), "config.json", text.encode("utf-8"))
        await self._require_launcher_runs()

    async def _files_dir_ready(self) -> bool:
        if (await self._adb.shell(f"ls {FILES_DIR}")).ok:
            return True
        await self._adb.shell(_OPEN_LAUNCHER)
        return (await self._adb.shell(f"ls {FILES_DIR}")).ok

    async def _push_atomic(self, scratch: Path, name: str, content: bytes) -> None:
        """Envia como `.tmp` e renomeia: o app nunca lê um arquivo pela metade."""
        local = scratch / name
        local.write_bytes(content)
        await self._adb.push(local, f"{FILES_DIR}/{name}.tmp")
        moved = await self._adb.shell(f"mv -f {FILES_DIR}/{name}.tmp {FILES_DIR}/{name}")
        if not moved.ok:
            raise LivreError("push_failed", "A TV não aceitou o arquivo.")

    async def _broadcast(self, config_text: str) -> None:
        encoded = base64.b64encode(config_text.encode("utf-8")).decode("ascii")
        result = await self._adb.shell(f"{_BROADCAST}'{encoded}'")
        if "result=1" not in result.text:
            raise LivreError("push_failed", "A TV não aceitou a configuração.")

    async def _set_home(self, disable_factory: bool) -> None:
        await self._require_installed()
        stored = await self._capture_original()
        factory = str(stored["factory"])
        # Antes de tocar na tela inicial: a home nova precisa abrir e ficar de pé.
        await self._require_launcher_runs()
        if not await self._set_home_activity(HOME_COMPONENT):
            raise LivreError("set_home_failed", "A TV não aceitou a nova tela inicial; nada mudou.")
        if await self._resolved_home_package() != PACKAGE:
            await self._restore_home(factory)
            raise LivreError(
                "verify_failed", "A nova tela inicial não ficou como padrão; voltei à original."
            )
        if not await self._runs(_OPEN_LAUNCHER, PACKAGE):
            await self._restore_home(factory)
            raise LivreError(
                "launcher_not_running",
                "A nova tela inicial não abriu como padrão; voltei à original.",
            )
        if not disable_factory:
            return
        package = _package_of(factory)
        disabled = list(stored.get("disabled", []))
        if package not in disabled:
            disabled.append(package)
            stored["disabled"] = disabled
            self._state.save(stored)  # antes de desativar: uma queda ainda deixa a volta possível
        result = await self._adb.shell(f"pm disable-user --user 0 {package}")
        if not result.ok or "disabled" not in result.text:
            await self._restore_home(factory, enable=True)
            await self._forget_disabled(stored, package)
            raise LivreError("disable_failed", "A TV não deixou desativar o launcher de fábrica.")
        if await self._resolved_home_package() != PACKAGE or not await self._runs(
            _OPEN_LAUNCHER, PACKAGE
        ):
            await self._restore_home(factory, enable=True)
            await self._forget_disabled(stored, package)
            raise LivreError(
                "verify_failed", "A tela inicial mudou ao desativar o original; reativei e voltei."
            )

    async def _resolved_home_package(self) -> str | None:
        component = await self._resolved_home()
        return _package_of(component) if component else None

    async def _forget_disabled(self, stored: dict[str, Any], package: str) -> None:
        stored["disabled"] = [p for p in stored.get("disabled", []) if p != package]
        self._state.save(stored)

    async def _restore(self, uninstall: bool) -> None:
        stored = self._state.load()
        previous = await self._resolved_home()
        candidates = [c for c in stored.get("candidates", []) if isinstance(c, str)]
        if isinstance(stored.get("factory"), str):
            candidates.insert(0, stored["factory"])
        if not candidates:
            candidates = [
                c
                for c in _components((await self._adb.shell(_QUERY_HOME)).text)
                if _package_of(c) != PACKAGE
            ]
        candidates = list(dict.fromkeys(candidates))
        disabled = [p for p in stored.get("disabled", []) if is_valid_package_name(p)]
        restored = False
        for component in candidates:
            package = _package_of(component)
            # 1. reabilita o launcher (se foi desativado) e 2. define como padrão.
            await self._adb.shell(f"pm enable --user 0 {package}")
            if (
                await self._set_home_activity(component)
                and await self._resolved_home_package() == package
                and await self._runs(f"am start -n {component}", package)
            ):
                restored = True
                break
        if not restored:
            # Não desinstala nada: o launcher novo segue como estava.
            if previous is not None:
                await self._restore_home(previous)
            raise LivreError(
                "verify_failed",
                "Não consegui confirmar a tela inicial original; nada foi desinstalado.",
            )
        remaining: list[str] = []
        for package in disabled:
            result = await self._adb.shell(f"pm enable --user 0 {package}")
            if not result.ok:
                remaining.append(package)
        stored["disabled"] = remaining
        self._state.save(stored)
        if uninstall:
            result = await self._adb.shell(f"pm uninstall {PACKAGE}")
            if "Success" not in result.text and "Unknown package" not in result.text:
                raise LivreError(
                    "uninstall_failed", "A TV voltou ao original, mas não desinstalou o TV Livre."
                )
        if not remaining:
            self._state.delete()

    async def _live_protected(self) -> frozenset[str]:
        """Pacotes que a TV usa agora e que nunca se desativam (lidos; falha de leitura recusa)."""
        protected = {PACKAGE}
        stored = self._state.load()
        if isinstance(stored.get("factory"), str):
            protected.add(_package_of(stored["factory"]))
        protected.update(
            _package_of(c) for c in _components((await self._adb.shell(_QUERY_HOME)).text)
        )
        ime = (await self._adb.shell("settings get secure default_input_method")).text.strip()
        accessibility = (
            await self._adb.shell("settings get secure enabled_accessibility_services")
        ).text.strip()
        protected.update(_OWNER_OF_COMPONENT.findall(f"{ime}\n{accessibility}"))
        return frozenset(protected)

    async def _set_apps(self, disable: list[str], enable: list[str]) -> None:
        packages = [*disable, *enable]
        if not all(is_valid_package_name(p) for p in packages):
            raise LivreError("invalid_package", "Nome de pacote inválido.", rejected=True)
        stored = self._state.load()
        disabled = [p for p in stored.get("disabled", []) if is_valid_package_name(p)]
        if disable:
            live = await self._live_protected()
            blocked = [p for p in disable if is_protected_for_disable(p, live)]
            if blocked:
                raise LivreError(
                    "protected_package",
                    "Um dos apps é peça do sistema e não pode ser desativado.",
                    rejected=True,
                )
        for package in disable:
            if package not in disabled:
                disabled.append(package)
                stored["disabled"] = disabled
                self._state.save(stored)  # antes: se cair no meio, a volta ainda reativa
            result = await self._adb.shell(f"pm disable-user --user 0 {package}")
            if not result.ok or "disabled" not in result.text:
                disabled.remove(package)
                stored["disabled"] = disabled
                self._state.save(stored)
                raise LivreError("disable_failed", "A TV não deixou desativar o app.")
        for package in enable:
            result = await self._adb.shell(f"pm enable --user 0 {package}")
            if not result.ok:
                raise LivreError("enable_failed", "A TV não deixou reativar o app.")
            if package in disabled:
                disabled.remove(package)
                stored["disabled"] = disabled
                self._state.save(stored)

    async def _sleep(self) -> None:
        await self._require_installed()
        result = await self._adb.shell(f"am start -n {SLEEP_COMPONENT}")
        if not result.ok or "Error" in result.text:
            raise LivreError("sleep_failed", "A TV não abriu o Modo Dormir.")

    # --- auditoria ----------------------------------------------------------------------------

    def audit(self, action: str, code: str, detail: str = "") -> None:
        """Um registro curto por ação (guardado no mesmo arquivo de estado e no log do agente)."""
        _log.info("tv.livre %s -> %s %s", action, code, detail)
        stored = self._state.load()
        entries = [e for e in stored.get("audit", []) if isinstance(e, dict)]
        entries.append(
            {
                "at": self._clock.now().isoformat(timespec="seconds"),
                "action": action,
                "result": code,
            }
        )
        stored["audit"] = entries[-AUDIT_LIMIT:]
        try:
            self._state.save(stored)
        except OSError:
            _log.warning("não consegui gravar a auditoria do TV Livre")


def tv_livre_handler(livre: TvLivre, transport: Transport, envelopes: EnvelopeFactory) -> Handler:
    """`tv.livre.v1`: executa a ação, manda o estado (antes do resultado) e responde."""

    async def handle(command: Command) -> CommandResult:
        request_id = command.body.get("requestId")
        action = str(command.body.get("action", ""))
        if not isinstance(request_id, str) or not request_id:
            return CommandResult(command.id, ResultStatus.REJECTED, "campo 'requestId' ausente")
        outcome = await _run(livre, command.body)
        livre.audit(action, outcome.code or "ok", _detail(command.body))
        try:
            state = await livre.read_state()
            await transport.send(
                envelopes.tv_livre_state(
                    request_id,
                    command.id,
                    supported=state.supported,
                    sdk=state.sdk,
                    installed=state.installed,
                    version=state.version,
                    is_home=state.is_home,
                    factory_launcher=state.factory_launcher,
                    disabled_packages=state.disabled_packages,
                    apps=[(a.package, a.factory, a.disabled) for a in state.apps],
                )
            )
        except AdbError:
            _log.info("TV Livre: sem estado para enviar (a TV não respondeu)")
        except TransportError:
            return CommandResult(
                command.id, ResultStatus.FAILED, "não consegui enviar o estado à API", SEND_FAILED
            )
        return CommandResult(command.id, outcome.status, outcome.detail, outcome.code)

    return handle


def _detail(body: dict[str, Any]) -> str:
    count = len(body.get("disable") or []) + len(body.get("enable") or [])
    return f"({count} apps)" if count else ""


async def _run(livre: TvLivre, body: dict[str, Any]) -> CommandResult:
    ok = CommandResult("", ResultStatus.OK)
    try:
        await livre.run(body)
    except LivreError as exc:
        status = ResultStatus.REJECTED if exc.rejected else ResultStatus.FAILED
        return CommandResult("", status, exc.message, exc.code)
    except LauncherApkError as exc:
        return CommandResult("", ResultStatus.FAILED, exc.message, exc.code)
    except AdbError as exc:
        return CommandResult("", ResultStatus.FAILED, exc.message, exc.code)
    except Exception:
        _log.exception("falha inesperada no TV Livre")
        return CommandResult(
            "", ResultStatus.FAILED, "O TV Livre falhou por um erro inesperado.", "livre_failed"
        )
    return ok


def tv_livre_photo_handler(photos: PhotoStaging) -> Handler:
    """`tv.livre.photo.v1`: recebe um pedaço da foto do fundo (rápido, no laço de mensagens)."""

    async def handle(command: Command) -> CommandResult:
        body = command.body
        try:
            photos.add(
                str(body["photoId"]),
                int(body["index"]),
                int(body["total"]),
                str(body["sha256"]),
                str(body["data"]),
            )
        except LivreError as exc:
            return CommandResult(command.id, ResultStatus.REJECTED, exc.message, exc.code)
        return CommandResult(command.id, ResultStatus.OK)

    return handle
