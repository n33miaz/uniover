"""Ajustes leves e reversíveis da Android TV.

Nada é aplicado antes da configuração da API. Os valores lidos antes da primeira alteração são
gravados em disco (sobrevivem ao reinício do agente) para que desligar o ajuste devolva exatamente o
que a TV informou, inclusive quando não havia valor.
"""

import asyncio
import json
import logging
import os
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Final

from uniover_agent.core.tv.cleanup import is_protected
from uniover_agent.ports import AdbError, Clock, TvAdbCleanup

_log = logging.getLogger(__name__)
ANIMATION_SETTINGS: Final = (
    "window_animation_scale",
    "transition_animation_scale",
    "animator_duration_scale",
)
SHORT_ANIMATION_SCALE: Final = "0.5"
FOCUS_POLL_SECONDS: Final = 30.0
FOCUS_STOP_GRACE_SECONDS: Final = 180.0
VIDEO_PACKAGES: Final = frozenset(
    {
        "com.google.android.youtube.tv",
        "com.netflix.ninja",
        "com.amazon.amazonvideo.livingroom",
        "com.disney.disneyplus",
        "com.wbd.stream",
        "com.globo.globotv",
        "tv.twitch.android.app",
        "com.plexapp.android",
        "org.xbmc.kodi",
        "com.cnvs.apptv",
        "org.videolan.vlc",
        "com.crunchyroll.crunchyroid",
        "com.apple.atve.androidtv.appletv",
        "tv.pluto.android",
        "com.cbs.ott",
    }
)
# Além da lista de nunca fechar da limpeza (sistema, controle remoto, nome com "remote"), ficam de
# fora a Play Store, os lançadores e os teclados conhecidos. O que a TV usar de verdade (tela
# inicial, teclado e acessibilidade) é lido dela antes de cada primeiro `appops`.
BLOCKED_BACKGROUND_PACKAGES: Final = frozenset(
    {
        "com.android.vending",
        "com.android.tvlauncher",
        "com.google.android.tvlauncher",
        "com.google.android.apps.tv.launcherx",
        "com.google.android.leanbacklauncher",
        "com.google.android.inputmethod.latin",
        "com.google.android.marvin.talkback",
        "com.android.packageinstaller",
        "com.google.android.packageinstaller",
        "com.google.android.permissioncontroller",
    }
)
BLOCKED_BACKGROUND_PREFIXES: Final = ("com.android.inputmethod.",)


def can_restrict_background(package: str) -> bool:
    """Só apps de uso entram; uma dúvida protege o sistema e o controle remoto."""
    return not (
        package in BLOCKED_BACKGROUND_PACKAGES
        or package.startswith(BLOCKED_BACKGROUND_PREFIXES)
        or is_protected(package)
    )


class LightSettingsStateError(Exception):
    """Os valores originais não puderam ser gravados: nenhuma mudança na TV pode acontecer."""


class TvLightSettings:
    def __init__(  # noqa: PLR0913, PLR0917 - dependências independentes, todas injetadas
        self,
        adb: TvAdbCleanup,
        clock: Clock,
        keep_hot: Callable[[bool], None],
        foreground: Callable[[], str | None] = lambda: None,
        state_path: Path | None = None,
        wake: Callable[[], Awaitable[None]] | None = None,
        on_focus: Callable[[str | None], Awaitable[None]] | None = None,
        on_focus_end: Callable[[], None] | None = None,
    ) -> None:
        self._adb, self._clock, self._keep_hot = adb, clock, keep_hot
        self._foreground = foreground
        self._state_path = state_path
        self._wake_session = wake
        # Ganchos do fechamento de apps de fundo (opcional): chamados só com o foco ativo.
        self._on_focus, self._on_focus_end = on_focus, on_focus_end
        self._animations_original, self._background_original = self._read_state()
        self._focus_enabled = False
        self._focus_active = False
        self._last_playing: float | None = None
        self._wake = asyncio.Event()
        self._closed = False
        self._on_release: list[Callable[[], None]] = []

    @property
    def focus_active(self) -> bool:
        return self._focus_active

    def on_release(self, callback: Callable[[], None]) -> None:
        """Quem adiou trabalho durante o foco é avisado quando a trégua termina, para retomá-lo."""
        self._on_release.append(callback)

    async def configure(
        self, focus_enabled: bool, short_animations: bool, restricted_packages: list[str]
    ) -> None:
        self._focus_enabled = focus_enabled
        if not focus_enabled:
            self._set_focus(False)
        self._wake.set()
        await self._reconcile(short_animations, restricted_packages)

    async def _reconcile(self, short_animations: bool, restricted_packages: list[str]) -> None:
        """Leva a TV ao pedido: primeiro desfaz o que não vale mais, depois aplica o que é novo."""
        wanted = {package for package in restricted_packages if can_restrict_background(package)}
        protected = await self._read_protected(wanted)
        if protected is not None:
            wanted -= protected
        await self._restore(short_animations, wanted)
        # Sem a leitura das proteções nenhum app novo é restringido; os já restringidos seguem.
        keep = wanted if protected is not None else wanted & self._background_original.keys()
        try:
            await self._engage(short_animations, keep)
        except LightSettingsStateError:
            _log.warning("não consegui guardar os valores originais; a TV não foi alterada")
        except (AdbError, ValueError) as exc:
            _log.info("ajuste leve da TV não aplicado (%s)", type(exc).__name__)

    async def _read_protected(self, wanted: set[str]) -> set[str] | None:
        """HOME, teclado e acessibilidade em uso agora; `None` se a TV não respondeu.

        A lista da tela é só uma sugestão: um desses três pode ser um app de terceiro, e passar a
        sê-lo depois de restringido. Por isso a leitura vale para todo pacote, a cada rodada.
        """
        if not wanted and not self._background_original:
            return set()
        try:
            homes = await self._adb.home_packages()
            keyboard = await self._adb.input_method_package()
            accessibility = await self._adb.accessibility_packages()
        except AdbError as exc:
            _log.info("proteções da TV não lidas (%s)", exc.code)
            return None
        return set(homes) | set(accessibility) | ({keyboard} if keyboard is not None else set())

    async def _restore(self, short_animations: bool, wanted: set[str]) -> None:
        """Devolve o original só do que deixou de valer. Uma falha não trava o resto."""
        if not short_animations:
            for name in list(self._animations_original):
                if await self._try_restore_animation(name):
                    del self._animations_original[name]
        for package in sorted(set(self._background_original) - wanted):
            if await self._try_restore_background(package):
                del self._background_original[package]
        self._save_best_effort()

    async def _try_restore_animation(self, name: str) -> bool:
        try:
            await self._adb.restore_global_setting(name, self._animations_original[name])
        except (AdbError, ValueError) as exc:
            _log.info("animação não restaurada agora (%s); tentarei de novo", type(exc).__name__)
            return False
        return True

    async def _try_restore_background(self, package: str) -> bool:
        try:
            await self._adb.set_app_background_mode(
                package, self._background_original[package] or "default"
            )
        except (AdbError, ValueError) as exc:
            # Um app que sumiu da TV não impede os outros de voltarem ao original; fica anotado e
            # a próxima configuração tenta de novo.
            _log.info("app não restaurado agora (%s); tentarei de novo", type(exc).__name__)
            return False
        return True

    async def _engage(self, short_animations: bool, wanted: set[str]) -> None:
        """Aplica o pedido. Todos os originais são lidos e gravados antes da primeira mudança."""
        names = (
            [name for name in ANIMATION_SETTINGS if name not in self._animations_original]
            if short_animations
            else []
        )
        packages = sorted(wanted - self._background_original.keys())
        read_animations = {name: await self._adb.global_setting(name) for name in names}
        read_modes = {package: await self._adb.app_background_mode(package) for package in packages}
        if read_animations or read_modes:
            # Sem o original em disco não se toca na TV: um reinício do agente perderia a volta.
            self._save_strict(
                {**self._animations_original, **read_animations},
                {**self._background_original, **read_modes},
            )
            self._animations_original.update(read_animations)
            self._background_original.update(read_modes)
        try:
            if short_animations:
                for name in ANIMATION_SETTINGS:
                    await self._adb.put_global_setting(name, SHORT_ANIMATION_SCALE)
            for package in sorted(wanted):
                await self._adb.set_app_background_mode(package, "ignore")
        except AdbError, ValueError:
            await self._roll_back(read_animations, read_modes)
            raise

    async def _roll_back(
        self, animations: dict[str, str | None], modes: dict[str, str | None]
    ) -> None:
        """Erro no meio: volta ao original tudo o que esta rodada registrou (mudado ou não)."""
        for name in animations:
            if await self._try_restore_animation(name):
                del self._animations_original[name]
        for package in modes:
            if await self._try_restore_background(package):
                del self._background_original[package]
        self._save_best_effort()

    def _read_state(self) -> tuple[dict[str, str | None], dict[str, str | None]]:
        if self._state_path is None:
            return {}, {}
        try:
            value = json.loads(self._state_path.read_text(encoding="utf-8"))
            if not isinstance(value, dict):
                return {}, {}
            animations = value.get("animations", {})
            background = value.get("background", {})
            if not isinstance(animations, dict) or not isinstance(background, dict):
                return {}, {}
            return (
                {
                    name: original
                    for name, original in animations.items()
                    if isinstance(name, str)
                    and name in ANIMATION_SETTINGS
                    and isinstance(original, str | type(None))
                },
                {
                    package: original
                    for package, original in background.items()
                    if isinstance(package, str) and isinstance(original, str | type(None))
                },
            )
        except OSError, ValueError, TypeError:
            return {}, {}

    def _save_strict(
        self, animations: dict[str, str | None], background: dict[str, str | None]
    ) -> None:
        """Grava por inteiro ou não grava: arquivo temporário e `replace`, nunca pela metade."""
        if self._state_path is None:
            return
        try:
            if not animations and not background:
                self._state_path.unlink(missing_ok=True)
                return
            self._state_path.parent.mkdir(parents=True, exist_ok=True)
            temporary = self._state_path.with_name(self._state_path.name + ".tmp")
            temporary.write_text(
                json.dumps({"animations": animations, "background": background}), encoding="utf-8"
            )
            os.replace(temporary, self._state_path)
        except OSError as exc:
            raise LightSettingsStateError from exc

    def _save_best_effort(self) -> None:
        """Depois de desfazer: sem gravar, o estado antigo só repete uma restauração inofensiva."""
        try:
            self._save_strict(self._animations_original, self._background_original)
        except LightSettingsStateError:
            _log.warning("não consegui atualizar os valores originais dos ajustes leves da TV")

    async def run(self) -> None:
        try:
            while not self._closed:
                await self._wake.wait()
                self._wake.clear()
                while self._focus_enabled and not self._closed:
                    await self._check_focus()
                    await self._clock.sleep(FOCUS_POLL_SECONDS)
        finally:
            self._set_focus(False)

    async def _check_focus(self) -> None:
        try:
            owners = await self._adb.playing_media_packages()
        except AdbError:
            # Sem leitura confiável, a trégua termina: o trabalho de fundo nunca fica suspenso
            # no escuro.
            self._set_focus(False)
            return
        now = self._clock.monotonic()
        front = self._foreground()
        # Só vale o vídeo que está na frente **e** é dono da sessão que toca: com o Netflix
        # navegando e o Spotify tocando, ninguém está assistindo e nada pode ser fechado.
        if front in VIDEO_PACKAGES and front in owners:
            self._last_playing = now
            if self._set_focus(True):
                await self._warm_session()
            if self._on_focus is not None:
                await self._on_focus(front)
        elif self._last_playing is None or now - self._last_playing >= FOCUS_STOP_GRACE_SECONDS:
            self._set_focus(False)

    async def _warm_session(self) -> None:
        """Entrou no foco com a sessão talvez hibernada: acorda-a, sem nunca enviar tecla."""
        if self._wake_session is None:
            return
        try:
            await self._wake_session()
        except Exception:
            # Sessão que não abre (TV desligada, rede) não derruba o foco nem o laço.
            _log.info("sessão da TV não aquecida ao entrar no modo foco")

    def _set_focus(self, active: bool) -> bool:
        """Muda o estado do foco; devolve se mudou."""
        if self._focus_active == active:
            return False
        self._focus_active = active
        self._keep_hot(active)
        if not active:
            if self._on_focus_end is not None:
                self._on_focus_end()
            for callback in self._on_release:
                callback()
        return True

    async def aclose(self) -> None:
        self._closed = True
        self._wake.set()
