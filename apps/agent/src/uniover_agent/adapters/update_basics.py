"""O que a configuração, a bandeja e o registro leem da atualização, sem a rede dela.

`self_update` importa httpx e cryptography; quem só precisa saber o canal, a versão gravada ou se
é um ensaio importa daqui e o processo não as carrega (a bandeja é o caso que pesa). O
`self_update` reexporta tudo, com os mesmos objetos.
"""

from dataclasses import dataclass, field
from pathlib import Path

# `main` e `develop` em agent.toml são valores legados do canal de produção. A branch ativa
# fica em um arquivo, sem precisar alterar cada PC ao migrar para main ou homolog.
CHANNELS = ("main", "develop", "homolog")
DEFAULT_CHANNEL = "develop"
# Ensaio de atualização (`tools/upgrade-drill.ps1`): com `UNIOVER_UPDATE_DRILL=1`, as duas
# consultas da atualização vão para um servidor local em vez do GitHub. Sem a variável de modo
# nada disso é lido, e em produção ela nunca existe.
DRILL_ENV = "UNIOVER_UPDATE_DRILL"
VERSION_FILE = ".version"


def read_version(source: Path) -> str | None:
    try:
        text = (source / VERSION_FILE).read_text(encoding="utf-8").strip()
    except OSError:
        return None
    return text or None


@dataclass(frozen=True, slots=True)
class UpdateResult:
    updated: bool
    message: str
    # Para o estado que a tela do dono mostra (`update-status.json`); `None` = nada a registrar.
    # Fora da comparação: quem compara resultados olha só `updated` e `message`.
    outcome: str | None = field(default=None, compare=False)
    latest: str | None = field(default=None, compare=False)
    blocked: str | None = field(default=None, compare=False)
    # A conferência de integridade recusou o pacote (e não uma falha comum de rede ou de disco).
    rejected: bool = field(default=False, compare=False)
