"""Lista e abertura de apps Samsung pelo mesmo canal do controle remoto."""

import base64
import re
from typing import Any, Protocol

from uniover_agent.core.envelopes import EnvelopeFactory
from uniover_agent.core.tv.apps import AppEntry
from uniover_agent.core.tv.icons import validate_icon
from uniover_agent.core.tv.session import TvSessionError
from uniover_agent.ports import AppIcon, Transport


class SamsungAppsDriver(Protocol):
    async def app_list(self) -> list[dict[str, Any]] | None: ...

    async def run_app(self, app_id: str) -> None: ...


class Wakeable(Protocol):
    async def wake(self) -> None: ...


_PACKAGE_PATTERN = re.compile(r"^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$")


class SamsungTvApps:
    """Adapta a lista Tizen ao contrato de apps, guardando a relação com o `appId` original."""

    def __init__(
        self,
        tv: Wakeable,
        driver: SamsungAppsDriver,
        transport: Transport,
        envelopes: EnvelopeFactory,
    ) -> None:
        self._tv = tv
        self._driver = driver
        self._transport = transport
        self._envelopes = envelopes
        self._ids: dict[str, str] = {}
        self._icons: dict[str, AppIcon] = {}
        self.cache: list[AppEntry] | None = None

    async def refresh(self) -> list[AppEntry]:
        await self._tv.wake()
        listed = await self._driver.app_list()
        if listed is None:
            raise TvSessionError("unsupported", "a TV Samsung não informa a lista de apps")
        self._ids.clear()
        self._icons.clear()
        entries: list[AppEntry] = []
        for item in listed:
            app_id = item.get("appId") or item.get("app_id")
            if not isinstance(app_id, str) or not app_id:
                continue
            # O contrato chama esse campo de pacote e exige segmentos que começam por letra; o
            # id Tizen pode ser só numérico, então o alias fica válido sem perder o id original.
            alias = _app_alias(app_id)
            self._ids[alias] = app_id
            icon = _icon(item.get("imageBase64"))
            if icon is not None:
                self._icons[alias] = icon
            label = item.get("name") or item.get("app_name") or app_id
            entries.append(AppEntry(alias, str(label)[:100]))
        self.cache = entries
        return entries

    async def publish(self, apps: list[AppEntry], correlation_id: str | None = None) -> None:
        # Quando o EDEN devolve imagens, o contrato v2 já é o mesmo que a Android TV usa. Nos
        # firmwares sem EDEN continuamos no v1: a web conhece os ícones locais dos apps Tizen
        # comuns.
        if self._icons:
            await self._transport.send(
                self._envelopes.tv_apps_v2(
                    [(app.package, app.label, self._icons.get(app.package)) for app in apps],
                    correlation_id,
                )
            )
            return
        await self._transport.send(
            self._envelopes.tv_apps([(app.package, app.label) for app in apps], correlation_id)
        )

    async def launch_package(self, package: str) -> None:
        # O app pode ter sido salvo antes da última lista: se vier um `appId` direto, a TV ainda
        # recebe esse valor; se vier o alias atual, recuperamos o identificador Tizen exato.
        await self._tv.wake()
        await self._driver.run_app(self._ids.get(package, package))


def _app_alias(app_id: str) -> str:
    """Alias válido no contrato para um `appId` Tizen que pode conter só dígitos."""
    if _PACKAGE_PATTERN.fullmatch(app_id):
        return app_id
    normalized = "".join(char if char.isalnum() or char == "_" else "_" for char in app_id)
    return f"samsung.app.id{normalized or 'unknown'}"


def _icon(encoded: object) -> AppIcon | None:
    """Decodifica somente um PNG/WebP quadrado que caiba no contrato público."""
    if not isinstance(encoded, str):
        return None
    try:
        return validate_icon(base64.b64decode(encoded, validate=True))
    except ValueError:
        return None
