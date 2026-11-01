"""Dublê do TV Livre: uma TV Android que simula só o gerenciador de pacotes e a tela inicial.

Registra, na ordem, cada comando recebido (`log`) para os testes conferirem a SEQUÊNCIA segura, e
marca `black_screen` se algum passo deixar a TV sem nenhum launcher habilitado ou desinstalar a
home que está em uso. Nenhum teste fala com uma TV de verdade.
"""

import io
import os
from pathlib import Path

from PIL import Image

from uniover_agent.core.tv.livre import FILES_DIR, HOME_COMPONENT, PACKAGE
from uniover_agent.ports import LaunchableApp
from uniover_agent.ports.tv_livre import LauncherApk, LauncherApkError, ShellResult

FACTORY = "com.google.android.apps.tv.launcherx/.home.HomeActivity"
FACTORY_PACKAGE = "com.google.android.apps.tv.launcherx"
IME = "com.google.android.tv.inputmethod"
NETFLIX = "com.netflix.ninja"
YOUTUBE = "com.google.android.youtube.tv"
NOISE = "Init wrapper sys mutex successful...\r\nopen mma dev failed\r\n"
BLOAT = "com.example.bloatware"


class FakeAndroid:
    def __init__(  # noqa: PLR0913 - opções independentes do dublê
        self,
        *,
        sdk: int = 34,
        leanback: bool = True,
        homes: tuple[str, ...] = (FACTORY,),
        needs_user_flag: bool = False,
        reject_set_home: frozenset[str] = frozenset(),
        noise: bool = False,
    ) -> None:
        self.noise = noise
        self.die_after_disable = False  # a home nova cai depois de desativar o original
        self.dead: set[str] = set()  # apps que abrem mas não ficam de pé
        self.sdk = sdk
        self.leanback = leanback
        self.homes = list(homes)
        self.home = homes[0]
        self.needs_user_flag = needs_user_flag
        self.reject_set_home = reject_set_home
        self.installed = False
        self.files_dir = False
        self.files: dict[str, bytes] = {}
        self.disabled: set[str] = set()
        self.log: list[str] = []
        self.black_screen = False
        self.fail: set[str] = set()  # trechos de comando que respondem com falha
        self.ours_resolves = True  # falso: o sistema ignora a escolha da nossa home
        self.install_text = "Performing Streamed Install\nSuccess\n"
        self.packages: dict[str, str] = {  # pacote -> pasta do APK (de fábrica ou atualizado)
            FACTORY_PACKAGE: "/system_ext/priv-app/Launcher/Launcher.apk",
            IME: "/system/app/Ime/Ime.apk",
            "com.android.tv.settings": "/system/priv-app/Settings/Settings.apk",
            "com.google.android.tv.remote.service": "/system/app/Remote/Remote.apk",
            YOUTUBE: "/data/app/~~x/com.google.android.youtube.tv-y/base.apk",
            BLOAT: "/system/app/Bloat/Bloat.apk",
        }
        self.launchable = [YOUTUBE, NETFLIX, BLOAT, "com.android.tv.settings"]

    # --- estado simulado ----------------------------------------------------------------------

    def _enabled_homes(self) -> list[str]:
        out = [h for h in self.homes if h.split("/")[0] not in self.disabled]
        if self.installed and PACKAGE not in self.disabled:
            out.append(HOME_COMPONENT)
        return out

    def _current_home(self) -> str | None:
        enabled = self._enabled_homes()
        if self.home in enabled and not (self.home == HOME_COMPONENT and not self.ours_resolves):
            return self.home
        others = [h for h in enabled if h != HOME_COMPONENT]
        return others[0] if others else None

    def _check_black_screen(self) -> None:
        if not self._enabled_homes():
            self.black_screen = True

    # --- porta --------------------------------------------------------------------------------

    async def list_apps(self) -> list[LaunchableApp]:
        return [LaunchableApp(p, ".Main") for p in self.launchable if p not in self.disabled]

    async def push(self, local: Path, remote: str) -> None:
        self.log.append(f"push {remote}")
        if "push" in self.fail:
            raise RuntimeError("push falhou")
        self.files[remote] = local.read_bytes()  # noqa: ASYNC240 - dublê de teste

    async def install(self, apk: Path) -> ShellResult:
        self.log.append("install")
        if "install" in self.fail:
            return ShellResult(False, "Failure [INSTALL_FAILED_INSUFFICIENT_STORAGE]")
        if "mismatch" in self.fail:
            return ShellResult(False, "Failure [INSTALL_FAILED_UPDATE_INCOMPATIBLE: x]")
        self.installed = True
        return ShellResult(True, self.install_text)

    async def shell(self, command: str) -> ShellResult:
        result = await self._answer(command)
        # A TCL real imprime linhas de ruído antes de toda resposta.
        return ShellResult(result.ok, NOISE + result.text) if self.noise else result

    async def _answer(self, command: str) -> ShellResult:  # noqa: PLR0911, PLR0912 - tabela de comandos
        self.log.append(command)
        if any(trecho in command for trecho in self.fail):
            return ShellResult(False, "Error: falha simulada")
        if command == "getprop ro.build.version.sdk":
            return ShellResult(True, f"{self.sdk}\n")
        if command == "pm list features":
            return ShellResult(True, "feature:android.software.leanback\n" if self.leanback else "")
        if command == f"pm path {PACKAGE}":
            return ShellResult(
                self.installed, f"package:/data/app/{PACKAGE}/base.apk\n" if self.installed else ""
            )
        if command == f"dumpsys package {PACKAGE}":
            return ShellResult(True, "    versionName=0.30.0\n")
        if command.startswith("cmd package resolve-activity"):
            current = self._current_home()
            return ShellResult(
                True,
                f"priority=0 isDefault=true\n{current}\n" if current else "No activity found\n",
            )
        if command.startswith("cmd package query-activities"):
            lines = "\n".join(self._enabled_homes())
            return ShellResult(True, f"{len(self._enabled_homes())} activities found:\n{lines}\n")
        if command.startswith("cmd package set-home-activity"):
            return self._set_home(command)
        if command.startswith("pm disable-user"):
            package = command.rsplit(maxsplit=1)[-1]
            self.disabled.add(package)
            if self.die_after_disable:
                self.dead.add(PACKAGE)
            self._check_black_screen()
            return ShellResult(True, f"Package {package} new state: disabled-user\n")
        if command.startswith("pm enable"):
            package = command.rsplit(maxsplit=1)[-1]
            self.disabled.discard(package)
            return ShellResult(True, f"Package {package} new state: enabled\n")
        if command == "pm list packages -s -f":
            lines = (f"package:{path}={package}\n" for package, path in self.packages.items())
            return ShellResult(True, "".join(lines))
        if command.startswith("pidof "):
            package = command.rsplit(maxsplit=1)[-1]
            alive = (package != PACKAGE or self.installed) and package not in self.dead
            return ShellResult(alive, "4242\n" if alive else "")
        if command == "pm list packages -d":
            return ShellResult(True, "".join(f"package:{p}\n" for p in sorted(self.disabled)))
        if command == "settings get secure default_input_method":
            return ShellResult(True, f"{IME}/.Service\n")
        if command == "settings get secure enabled_accessibility_services":
            return ShellResult(True, "null\n")
        if command == f"ls {FILES_DIR}":
            return ShellResult(
                self.files_dir, "" if self.files_dir else "No such file or directory\n"
            )
        if command.startswith("mv -f "):
            _, _, source, target = command.split()
            self.files[target] = self.files.pop(source)
            return ShellResult(True, "")
        if command.startswith("am broadcast"):
            return ShellResult(True, 'Broadcast completed: result=1, data="revision=1 avisos=0"\n')
        if command.startswith("am start -n "):
            component = command.rsplit(maxsplit=1)[-1]
            if component.startswith(PACKAGE) and not self.installed:
                return ShellResult(False, "Error type 3\n")
            if component == HOME_COMPONENT:
                self.files_dir = True
            return ShellResult(True, f"Starting: Intent {{ cmp={component} }}\n")
        if command.startswith("am start -a"):
            return ShellResult(True, "Starting: Intent { act=android.intent.action.MAIN }\n")
        if command == f"pm uninstall {PACKAGE}":
            if (
                self._current_home() == HOME_COMPONENT
                or len([h for h in self._enabled_homes() if h != HOME_COMPONENT]) == 0
            ):
                self.black_screen = True
            self.installed = False
            return ShellResult(True, "Success\n")
        raise AssertionError(f"comando do shell sem resposta no teste: {command}")

    def _set_home(self, command: str) -> ShellResult:
        component = command.rsplit(maxsplit=1)[-1]
        if self.needs_user_flag and "--user 0" not in command:
            return ShellResult(False, "Error: Failed to set default home for user\n")
        if component in self.reject_set_home or component not in self._enabled_homes():
            return ShellResult(False, "Error: Failed to set default home\n")
        self.home = component
        return ShellResult(True, "Success\n")

    # --- consultas dos testes -----------------------------------------------------------------

    def mutating(self) -> list[str]:
        """Só o que muda a TV (instalar, definir home, desativar, desinstalar, copiar)."""
        marks = (
            "install",
            "set-home-activity",
            "pm disable",
            "pm enable",
            "pm uninstall",
            "push",
            "mv ",
        )
        return [c for c in self.log if c.startswith(marks)]

    def index(self, prefix: str, start: int = 0) -> int:
        return next(i for i, c in enumerate(self.log) if i >= start and c.startswith(prefix))


class FakeApkSource:
    def __init__(self, tmp: Path, error: LauncherApkError | None = None) -> None:
        self._tmp = tmp
        self._error = error
        self.fetches = 0

    async def fetch(self) -> LauncherApk:
        self.fetches += 1
        if self._error is not None:
            raise self._error
        path = self._tmp / "uniover-launcher.apk"
        path.write_bytes(b"PK\x03\x04fake")
        return LauncherApk(path, "0" * 64)


def jpeg_bytes(width: int = 32, height: int = 24) -> bytes:
    """Um JPEG de verdade (decodifica por inteiro), pequeno."""
    buffer = io.BytesIO()
    Image.new("RGB", (width, height), (30, 60, 120)).save(buffer, "JPEG")
    return buffer.getvalue()


def noisy_jpeg(side: int = 1200) -> bytes:
    """Um JPEG válido acima de 400 KiB (ruído não comprime)."""
    buffer = io.BytesIO()
    Image.frombytes("RGB", (side, side), os.urandom(side * side * 3)).save(
        buffer, "JPEG", quality=95
    )
    return buffer.getvalue()
