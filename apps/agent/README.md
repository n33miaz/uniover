# uniover-agent

Agente local do UniOver (Python 3.14). Roda no PC como processo do usuário e disca para fora, para a API.

## Comandos

```
uv sync
uv run ruff check
uv run ruff format --check
uv run mypy src tests
uv run lint-imports
uv run pytest
uv run uniover-agent
```

Variáveis: `UNIOVER_API_URL`, `UNIOVER_AGENT_ID`, `UNIOVER_LOG_LEVEL`.

## Arquitetura

- `core/`: casos de uso (`HandleCommand`) e tipos de domínio.
- `ports/`: `Transport`, `TvRemote`, `Clock`, `SecretStore` como `typing.Protocol`.
- `adapters/`: implementações das portas (hoje só `fakes.py`).
- `contracts/`: modelos gerados, não editar.
- `main.py`: composição.

## Regra do núcleo

`core/` e `ports/` nunca importam `adapters/` nem biblioteca de rede ou de TV. O `import-linter`
(`uv run lint-imports`) falha se isso acontecer.
