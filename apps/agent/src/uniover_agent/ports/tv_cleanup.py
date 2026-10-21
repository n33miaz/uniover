"""Porta da limpeza da TV: as leituras e os comandos curtos que fecham apps e medem a memória.

Tudo passa pelo mesmo canal ADB dos outros comandos (um por vez, com tempo-limite). Cada operação é
um comando **fixo**: nenhum texto livre chega ao shell da TV, e o nome de pacote é validado pelo
mesmo padrão de `launch_package` antes de sair.

As leituras levantam `AdbError` quando o ADB não responde ou o comando falha. "Não há valor" (o
campo `null` do Android, por exemplo) **não** é falha: volta como vazio ou `None`. A diferença
importa para quem decide o que proteger: ler errado não pode virar "nada a proteger".
"""

from typing import Protocol

from uniover_agent.ports.tv_adb import LaunchableApp


class TvAdbCleanup(Protocol):
    async def list_apps(self) -> list[LaunchableApp]:
        """Os apps que a TV mostra para abrir (a mesma fonte da lista de apps da tela)."""
        ...

    async def memory_available_mb(self) -> int | None:
        """`MemAvailable` de `/proc/meminfo`, em MB; `None` se a TV respondeu algo ilegível."""
        ...

    async def home_packages(self) -> frozenset[str]:
        """Pacotes que atendem a tela inicial (categoria HOME): o lançador e quem mais responder.

        Levanta `AdbError` também se a TV não nomeou nenhum (não dá para saber o que proteger).
        """
        ...

    async def input_method_package(self) -> str | None:
        """Pacote do teclado (IME) em uso; `None` quando nenhum está definido."""
        ...

    async def accessibility_packages(self) -> frozenset[str]:
        """Pacotes dos serviços de acessibilidade ligados (vazio quando não há nenhum)."""
        ...

    async def running_packages(self) -> frozenset[str]:
        """Pacotes com processo vivo agora. Levanta `AdbError` se a TV não devolveu a lista."""
        ...

    async def go_home(self) -> None:
        """Tecla HOME pelo ADB: o app em primeiro plano passa a ser "de fundo"."""
        ...

    async def kill_background(self) -> None:
        """`am kill-all`: encerra só processos de fundo e em cache (nunca o app da frente)."""
        ...

    async def force_stop(self, package: str) -> None:
        """`am force-stop` de um app. `ValueError` se o nome não tem o formato do Android."""
        ...
