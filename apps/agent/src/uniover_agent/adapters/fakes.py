"""Dublês das portas para testes e para a composição sem aparelhos reais."""

import asyncio
from collections.abc import AsyncIterator, Callable
from datetime import UTC, datetime
from typing import Any

from uniover_agent.ports import (
    AdbError,
    LaunchableApp,
    PairingInfo,
    PairingTicket,
    PollResult,
    TvUnreachable,
)


class FakeClock:
    """Relógio virtual: `sleep` não espera, só avança o tempo e registra a duração pedida."""

    def __init__(self, fixed: datetime | None = None) -> None:
        self._fixed = fixed
        self._elapsed = 0.0
        self.sleeps: list[float] = []

    def now(self) -> datetime:
        return self._fixed or datetime.now(UTC)

    def monotonic(self) -> float:
        return self._elapsed

    def advance(self, seconds: float) -> None:
        self._elapsed += seconds

    async def sleep(self, seconds: float) -> None:
        self.sleeps.append(seconds)
        self._elapsed += seconds
        # Cede a vez ao laço de eventos: sem isto um laço de reconexão nunca devolveria o controle.
        await asyncio.sleep(0)


class FakeTvRemote:
    """Controle remoto roteirizado: registra o que recebe e deixa o teste empurrar estado da TV.

    `connect_errors` é consumido em ordem (um item por `connect`); sem itens, conecta. `events`
    guarda, na ordem, tudo o que chegou como `("tecla", ...)` ou `("texto", ...)`; passando a mesma
    lista ao `FakeTvAdb` a ordem entre os dois canais também fica registrada.
    """

    def __init__(self, events: list[tuple[str, str]] | None = None) -> None:
        self.events: list[tuple[str, str]] = events if events is not None else []
        self.keys: list[str] = []
        self.sent: list[tuple[str, str]] = []
        self.links: list[str] = []
        self.texts: list[str] = []
        self.connects = 0
        self.disconnects = 0
        self.connect_errors: list[Exception] = []
        self.on_connect: Callable[[], None] | None = None
        self._connected = False
        self._power: list[Callable[[bool], None]] = []
        self._app: list[Callable[[str], None]] = []
        self._volume: list[Callable[[int], None]] = []
        self._available: list[Callable[[bool], None]] = []

    @property
    def connected(self) -> bool:
        return self._connected

    async def connect(self) -> None:
        self.connects += 1
        # Cede a vez: dois comandos juntos precisam poder disputar o mesmo aquecimento.
        await asyncio.sleep(0)
        if self.connect_errors:
            self._connected = False
            raise self.connect_errors.pop(0)
        self._connected = True
        if self.on_connect is not None:
            self.on_connect()

    async def disconnect(self) -> None:
        self.disconnects += 1
        self._connected = False

    async def send_key(self, key: str, direction: str = "SHORT") -> None:
        if not self._connected:
            raise TvUnreachable("canal fechado")
        self.keys.append(key)
        self.sent.append((key, direction))
        self.events.append(("tecla", key))

    async def launch_link(self, link: str) -> None:
        if not self._connected:
            raise TvUnreachable("canal fechado")
        self.links.append(link)

    async def send_text(self, text: str) -> None:
        if not self._connected:
            raise TvUnreachable("canal fechado")
        self.texts.append(text)
        self.events.append(("texto", text))

    def on_power(self, callback: Callable[[bool], None]) -> None:
        self._power.append(callback)

    def on_app(self, callback: Callable[[str], None]) -> None:
        self._app.append(callback)

    def on_volume(self, callback: Callable[[int], None]) -> None:
        self._volume.append(callback)

    def on_available(self, callback: Callable[[bool], None]) -> None:
        self._available.append(callback)

    # --- o que a TV empurra (usado pelos testes) ---

    def push_power(self, is_on: bool) -> None:
        for callback in self._power:
            callback(is_on)

    def push_app(self, app: str) -> None:
        for callback in self._app:
            callback(app)

    def push_volume(self, level: int) -> None:
        for callback in self._volume:
            callback(level)

    def drop(self) -> None:
        """A TV derrubou a sessão sem o agente pedir."""
        self._connected = False
        for callback in self._available:
            callback(False)


class FakeTvChannel:
    """Canal genérico (o ADB, por exemplo) para testar o gerenciador com mais de um canal."""

    def __init__(self) -> None:
        self.connects = 0
        self.disconnects = 0
        self.connect_error: Exception | None = None
        self._connected = False

    @property
    def connected(self) -> bool:
        return self._connected

    async def connect(self) -> None:
        self.connects += 1
        if self.connect_error is not None:
            raise self.connect_error
        self._connected = True

    async def disconnect(self) -> None:
        self.disconnects += 1
        self._connected = False


class FakeTvAdb:
    """Canal ADB roteirizado: registra o que recebe. `errors` é consumido, um por operação.

    `events` recebe `("adb", texto)` a cada digitação (a mesma lista do `FakeTvRemote` registra a
    ordem entre os canais).
    """

    def __init__(
        self,
        apps: list[LaunchableApp] | None = None,
        events: list[tuple[str, str]] | None = None,
    ) -> None:
        self.events: list[tuple[str, str]] = events if events is not None else []
        self.apps = list(apps or [])
        self.launched: list[tuple[str, str | None]] = []
        self.typed: list[str] = []
        self.connects = 0
        self.disconnects = 0
        self.errors: list[AdbError] = []
        # Vigia do serviço do controle: quantas vezes foi religado e o que falha (um por chamada).
        self.restarts = 0
        self.restart_errors: list[Exception] = []
        self._connected = False
        # Limpeza da TV: o que o dublê "lê" da TV e a ordem em que recebe os comandos.
        self.memory_mb: list[int | None] = [300, 700]
        self.home: frozenset[str] = frozenset({"com.google.android.tvlauncher"})
        self.keyboard: str | None = None
        self.accessibility: frozenset[str] = frozenset()
        self.running: frozenset[str] = frozenset()
        self.cleanup_log: list[str] = []
        self.cleanup_errors: dict[str, AdbError] = {}
        self.media_playing_value = False
        self.global_values: dict[str, str | None] = {
            "window_animation_scale": "1.0",
            "transition_animation_scale": "1.0",
            "animator_duration_scale": "1.0",
        }
        self.background_modes: dict[str, str | None] = {}

    @property
    def connected(self) -> bool:
        return self._connected

    def _fail_if_scripted(self) -> None:
        if self.errors:
            raise self.errors.pop(0)

    async def connect(self) -> None:
        self.connects += 1
        self._connected = False
        self._fail_if_scripted()
        self._connected = True

    async def disconnect(self) -> None:
        self.disconnects += 1
        self._connected = False

    async def list_apps(self) -> list[LaunchableApp]:
        self._fail_if_scripted()
        self._cleanup_step("list-apps")
        return list(self.apps)

    async def launch_package(self, package: str, activity: str | None = None) -> None:
        self._fail_if_scripted()
        self.launched.append((package, activity))

    async def input_text(self, text: str) -> None:
        self._fail_if_scripted()
        self.typed.append(text)
        self.events.append(("adb", text))

    async def restart_remote_service(self) -> None:
        self.restarts += 1
        if self.restart_errors:
            raise self.restart_errors.pop(0)

    # --- limpeza da TV: cada operação entra em `cleanup_log` e falha se `cleanup_errors` mandar ---

    def _cleanup_step(self, step: str) -> None:
        self.cleanup_log.append(step)
        error = self.cleanup_errors.get(step)
        if error is not None:
            raise error

    async def memory_available_mb(self) -> int | None:
        self._cleanup_step("memory")
        return self.memory_mb.pop(0) if len(self.memory_mb) > 1 else self.memory_mb[0]

    async def home_packages(self) -> frozenset[str]:
        self._cleanup_step("home-packages")
        return self.home

    async def input_method_package(self) -> str | None:
        self._cleanup_step("keyboard")
        return self.keyboard

    async def accessibility_packages(self) -> frozenset[str]:
        self._cleanup_step("accessibility")
        return self.accessibility

    async def running_packages(self) -> frozenset[str]:
        self._cleanup_step("running")
        return self.running

    async def media_playing(self) -> bool:
        self._cleanup_step("media")
        return self.media_playing_value

    async def global_setting(self, name: str) -> str | None:
        self._cleanup_step(f"global-get:{name}")
        return self.global_values[name]

    async def put_global_setting(self, name: str, value: str) -> None:
        self._cleanup_step(f"global-put:{name}:{value}")
        self.global_values[name] = value

    async def restore_global_setting(self, name: str, original: str | None) -> None:
        self._cleanup_step(f"global-restore:{name}:{original}")
        self.global_values[name] = original

    async def app_background_mode(self, package: str) -> str | None:
        self._cleanup_step(f"appops-get:{package}")
        return self.background_modes.get(package)

    async def set_app_background_mode(self, package: str, mode: str) -> None:
        self._cleanup_step(f"appops-set:{package}:{mode}")
        self.background_modes[package] = None if mode == "default" else mode

    async def go_home(self) -> None:
        self._cleanup_step("go-home")

    async def kill_background(self) -> None:
        self._cleanup_step("kill-background")

    async def force_stop(self, package: str) -> None:
        self._cleanup_step(f"force-stop:{package}")

    async def trim_memory(self, package: str) -> None:
        self._cleanup_step(f"trim-memory:{package}")


class FakeSecretStore:
    def __init__(self) -> None:
        self._data: dict[str, str] = {}

    def get(self, name: str) -> str | None:
        return self._data.get(name)

    def set(self, name: str, value: str) -> None:
        self._data[name] = value

    def delete(self, name: str) -> None:
        self._data.pop(name, None)


class FakeTransport:
    """Transporte roteirizado: cada `connect` consome uma sessão; `Exception` é levantada."""

    def __init__(self, sessions: list[list[str | bytes | Exception]] | None = None) -> None:
        self.sessions = list(sessions or [])
        self.sent: list[dict[str, Any]] = []
        self.connects = 0
        self.closes = 0
        self.connect_error: Exception | None = None
        self._current: list[str | bytes | Exception] = []
        self._connected = False

    @property
    def connected(self) -> bool:
        return self._connected

    async def connect(self) -> None:
        self.connects += 1
        if self.connect_error is not None:
            raise self.connect_error
        self._current = self.sessions.pop(0) if self.sessions else []
        self._connected = True

    async def send(self, message: dict[str, Any]) -> None:
        self.sent.append(message)

    async def incoming(self) -> AsyncIterator[str | bytes]:
        for item in self._current:
            if isinstance(item, Exception):
                raise item
            yield item

    async def close(self) -> None:
        self.closes += 1
        self._connected = False


class FakePairingClient:
    """Cliente de pareamento roteirizado: devolve ou levanta cada item de `polls` em ordem."""

    def __init__(self, ticket: PairingTicket, polls: list[PollResult | Exception]) -> None:
        self.ticket = ticket
        self.polls = list(polls)
        self.started: list[PairingInfo] = []
        self.poll_count = 0
        self.start_errors: list[Exception] = []

    async def start(self, info: PairingInfo) -> PairingTicket:
        self.started.append(info)
        if self.start_errors:
            raise self.start_errors.pop(0)
        return self.ticket

    async def poll(self, ticket: PairingTicket) -> PollResult:
        self.poll_count += 1
        item = self.polls.pop(0)
        if isinstance(item, Exception):
            raise item
        return item
