"""Portas do controle do PC: o que o núcleo pede ao sistema, sem saber que é o Windows.

Tudo é síncrono e rápido (uma chamada de sistema), salvo `PcPower.sleep`, que só volta quando o PC
acorda e por isso o manipulador o roda em outra thread.
"""

from collections.abc import Callable, Sequence
from dataclasses import dataclass
from typing import Protocol


class PcUnsupported(Exception):  # noqa: N818 - lê-se como fato: este sistema não faz isto
    """O sistema não consegue executar o pedido (por exemplo, o agente não está no Windows)."""


# Códigos estáveis de `PcInputRefused.cause`: o app mostra um texto para cada um.
CAUSE_SESSION_LOCKED = "session_locked"
CAUSE_ELEVATED_WINDOW = "elevated_window"
CAUSE_UNKNOWN = "failed"


class PcInputRefused(OSError):  # noqa: N818 - o nome diz o que aconteceu
    """O sistema recusou a entrada (mouse ou teclado). `cause` é o código estável da causa:
    `session_locked` (tela de bloqueio ou desktop seguro na frente), `elevated_window` (uma janela
    com mais privilégio no primeiro plano) ou `failed` (não deu para saber). `detail` são os fatos
    medidos, sem título de janela nem endereço, para o registro."""

    def __init__(self, message: str, cause: str = CAUSE_UNKNOWN, detail: str = "") -> None:
        super().__init__(message)
        self.cause = cause
        self.detail = detail


class PcInput(Protocol):
    """Mouse e teclado do PC."""

    def move(self, dx: int, dy: int) -> None:
        """Move o ponteiro, em pixels relativos à posição atual."""
        ...

    def scroll(self, horizontal: int, vertical: int) -> None:
        """Rola, em unidades de roda (120 = um clique). Positivo: para cima e para a direita."""
        ...

    def zoom(self, steps: int) -> None:
        """Zoom pela roda com o Ctrl: `steps` cliques de roda (positivo aproxima, negativo afasta).
        O Ctrl é apertado, a roda gira e o Ctrl é solto no mesmo lote: nunca fica preso. Um Ctrl que
        já está segurado (`key` com `DOWN`) não é apertado de novo nem solto."""
        ...

    def click(self, button: str, action: str, modifiers: Sequence[str] = ()) -> None:
        """`button`: LEFT, RIGHT ou MIDDLE. `action`: CLICK, DOUBLE, DOWN ou UP. `modifiers` (só
        com CLICK e DOUBLE): apertados antes do clique e soltos depois, no mesmo lote."""
        ...

    def key(
        self, key: str, modifiers: Sequence[str], *, repeat: int = 1, action: str = "PRESS"
    ) -> None:
        """Aperta e solta uma tecla do contrato `repeat` vezes, com os modificadores seguros
        enquanto isso. `action` `DOWN` ou `UP` só aperta ou só solta um modificador (segurar entre
        toques, como o Alt do Alt+Tab): o que ficar apertado é solto por `release_all`."""
        ...

    def type_text(self, text: str) -> None:
        """Digita o texto como caracteres Unicode (não depende do layout do teclado)."""
        ...

    def edit_text(self, erase: int, text: str, key: str | None = None) -> None:
        """Apaga `erase` caracteres, digita `text` e aperta `key` (ENTER ou TAB), nesta ordem e no
        mesmo toque no sistema."""
        ...

    def media(self, action: str, steps: int) -> None:
        """Tecla de mídia do contrato; `steps` repete (volume)."""
        ...

    def release_all(self) -> None:
        """Solta todo botão do mouse e toda tecla que ficou apertado (DOWN sem UP). Sem nenhum, não
        faz nada.

        Nunca levanta erro: é chamado quando a conexão cai e ao encerrar, momentos em que não há
        a quem reportar a falha.
        """
        ...

    def release_orphans(self) -> None:
        """Solta todo modificador (Shift, Ctrl, Alt, Win) e todo botão do mouse que o sistema dá por
        apertado, mesmo os que este processo não apertou (a execução anterior do agente saiu
        segurando um). Só envia o que está apertado de verdade; sem nenhum, não faz nada. Nunca
        levanta erro."""
        ...


@dataclass(frozen=True, slots=True)
class VolumeState:
    """O volume principal do dispositivo de saída padrão: nível de 0 a 100 e mudo."""

    level: int
    muted: bool


class PcAudio(Protocol):
    """O áudio do PC. Nunca é tocado pelos testes: a implementação do Windows fala com o sistema."""

    def read(self) -> VolumeState:
        """O volume de agora."""
        ...

    def set_level(self, level: int) -> None:
        """Define o nível (0 a 100) sem mexer no mudo."""
        ...

    def set_muted(self, muted: bool) -> None:
        """Liga ou desliga o mudo, sem alternar e sem mexer no nível."""
        ...


class PcPower(Protocol):
    """Energia do PC."""

    def lock(self) -> None: ...

    def sleep(self) -> None:
        """Suspende. Só volta quando o PC acorda."""
        ...

    def shutdown(self, delay_seconds: int, countdown_id: str = "") -> None:
        """Agenda o desligamento com uma contagem cancelável no agente; ao fim, pede ao Windows sem
        forçar o fechamento dos programas. `countdown_id` é o identificador opaco da contagem (o id
        do comando que a pediu): volta à API no desfecho, para ela saber de qual se trata."""
        ...

    def cancel_shutdown(self, countdown_id: str | None = None) -> bool:
        """Cancela a contagem (de desligar ou reiniciar); sem contagem em andamento não é erro. Com
        `countdown_id`, só cancela se a contagem em andamento for essa: com outra (ou nenhuma), não
        faz nada e devolve `False` (o app mostrava uma contagem que já acabou)."""
        ...

    def restart(self, delay_seconds: int, countdown_id: str = "") -> None:
        """Agenda o reinício com uma contagem cancelável no agente (`cancel_shutdown`); ao fim, pede
        ao Windows sem forçar o fechamento dos programas."""
        ...

    def hibernation_available(self) -> bool:
        """A hibernação está ligada neste PC? Só lê; nunca hiberna. Sem ela `hibernate` não faz o
        que se pede (o Windows suspenderia no lugar)."""
        ...

    def hibernate(self) -> None:
        """Hiberna. Só volta quando o PC acorda."""
        ...

    def log_off(self) -> None:
        """Encerra a sessão do Windows em que o agente roda: os programas são chamados a fechar e o
        próprio agente cai com ela."""
        ...

    def monitor_off(self) -> None:
        """Apaga a tela; o PC segue ligado e qualquer toque no mouse ou tecla a acende."""
        ...


class PowerNotice(Protocol):
    """O aviso na tela do PC durante a contagem de desligar ou reiniciar: quem está na frente do PC
    vê quanto falta e pode cancelar ali mesmo. Nada vai a disco."""

    def show(
        self, countdown_id: str, action: str, seconds: int, cancel: Callable[[], None]
    ) -> None:
        """Abre o aviso da contagem `countdown_id` (`action`: `SHUTDOWN` ou `RESTART`) sem esperar
        por ele. `cancel` é chamado se a pessoa pedir o cancelamento no próprio aviso. Um aviso
        anterior ainda aberto fecha."""
        ...

    def close(self, countdown_id: str) -> None:
        """Fecha o aviso da contagem `countdown_id` (ela acabou ou foi cancelada pelo app), sem
        esperar. O aviso de outra contagem fica; sem aviso aberto, não faz nada."""
        ...


class PowerCountdownMarker(Protocol):
    """A marca da contagem em andamento, que sobrevive a um reinício do agente (a contagem em si
    vive só na memória). Nunca levanta erro."""

    def save(self, action: str, countdown_id: str) -> None:
        """Marca que a contagem `countdown_id` de `action` (`SHUTDOWN` ou `RESTART`) corre."""
        ...

    def clear(self) -> None:
        """A contagem acabou (cancelada ou entregue ao Windows)."""
        ...

    def take_lost(self) -> list[tuple[str, str]]:
        """A ação e o id de cada contagem perdida (a que corria quando o agente anterior parou, e
        as de antes) cujo aviso a API ainda não confirmou. A marca da contagem sai; a perdida fica
        guardada até `confirm_lost`."""
        ...

    def confirm_lost(self, countdown_id: str) -> None:
        """A API confirmou o aviso da contagem perdida `countdown_id`: ela é esquecida."""
        ...


class PcLauncher(Protocol):
    """Abre um programa ou endereço."""

    def launch(self, target: str) -> None: ...


class PcForeground(Protocol):
    """O programa da janela em primeiro plano (a que recebe as teclas)."""

    def program(self) -> str | None:
        """O nome do executável, em minúsculas e sem pasta (`chrome.exe`); `None` se não dá para
        saber (nenhuma janela, ou uma de administrador que este processo não pode abrir). Nunca o
        título da janela."""
        ...
