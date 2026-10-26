"""O registro do agente sai do PC pela manutenção remota: nada nele aponta para a rede da casa."""

import ast
from pathlib import Path

SOURCE = Path(__file__).parents[1] / "src" / "uniover_agent"
# Nomes que, num argumento de registro, carregam o endereço interno de um aparelho.
ADDRESS_NAMES = {"host", "tv_host", "control", "location", "serial", "address", "url", "base_url"}
LOG_METHODS = {"debug", "info", "warning", "error", "exception", "critical"}


def _leaks(path: Path) -> list[str]:
    found: list[str] = []
    for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
        if not (
            isinstance(node, ast.Call)
            and isinstance(node.func, ast.Attribute)
            and node.func.attr in LOG_METHODS
            and ast.unparse(node.func.value) in {"_log", "log", "logging", "logger"}
        ):
            continue
        # O primeiro argumento é o texto; os demais (e os f-strings) é que podem vazar o endereço.
        values = [*node.args[1:], *(keyword.value for keyword in node.keywords)]
        values += [part for part in ast.walk(node.args[0]) if isinstance(part, ast.FormattedValue)]
        for value in values:
            for name in ast.walk(value):
                identifier = (
                    name.id
                    if isinstance(name, ast.Name)
                    else name.attr
                    if isinstance(name, ast.Attribute)
                    else ""
                )
                if identifier in ADDRESS_NAMES:
                    found.append(f"{path.name}:{node.lineno} {ast.unparse(node)}")
    return found


def test_no_log_call_prints_the_host_or_the_url_of_a_device() -> None:
    leaks = [leak for path in sorted(SOURCE.rglob("*.py")) for leak in _leaks(path)]
    assert leaks == []
