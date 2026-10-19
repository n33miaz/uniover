# uniover-agent

Agente local do UniOver (Python 3.14). Roda no PC como processo do usuário e **disca para fora**, para a API:
nunca abre porta.

## Comandos

```
uv sync
uv run uniover-agent pair      # pareia este PC com um código curto
uv run uniover-agent run       # conecta e roda em primeiro plano (é o padrão)
uv run uniover-agent status    # diz se há token no cofre e se a API responde
```

Verificação do projeto:

```
uv run ruff check
uv run ruff format --check
uv run mypy src tests
uv run lint-imports
uv run pytest
```

## Pareamento

1. `uniover-agent pair` pede um código à API, **mostra** `XXXX-XXXX` e o endereço do app e consulta até o dono
   aprovar (respeitando o intervalo e o `slow_down`) ou o código vencer.
2. Aprovado, o **token de dispositivo** vai para o **Cofre de Credenciais do Windows** (serviço `uniover-agent`,
   nome = `agentId`) e o `agentId` para a configuração local. Nenhum dos dois vai para o repositório.
3. `uniover-agent run` lê o token do cofre a cada conexão e o envia só no cabeçalho `Authorization` do *upgrade*.
   Nunca em URL, log, argumento de linha de comando ou variável de ambiente.

Cada PC é um agente separado (um pareamento e um `agentId` por PC). Em Linux/macOS (desenvolvimento) usa o
cofre que o `keyring` achar e **recusa** um backend em texto claro (`keyrings.alt`).

Com a API dormindo (Render grátis), acordar leva de 1 a mais de 4 minutos: o pareamento e a conexão esperam e
tentam de novo, sem desistir.

## Configuração

Variáveis de ambiente (vencem o arquivo):

| Variável | Para quê |
|---|---|
| `UNIOVER_API_URL` | endereço da API; precisa ser `https://` |
| `UNIOVER_AGENT_ID` | `agentId` deste PC (o `pair` grava no arquivo) |
| `UNIOVER_LOG_LEVEL` | `DEBUG`, `INFO` (padrão), `WARNING` ou `ERROR` |
| `UNIOVER_ALLOW_INSECURE` | `1` libera `http://`/`ws://` para a API local em desenvolvimento (com aviso) |
| `UNIOVER_CONFIG_FILE` | outro caminho para o arquivo de configuração |

Arquivo local (fora do repositório): `%LOCALAPPDATA%\UniOver\agent.toml`, com `api_url` e `agent_id`. Nunca
guarda segredo.

## Conexão

- `wss://<api>/api/v1/devices/agents/<agentId>/ws`, `ping` a cada 20 s, mensagens de texto JSON de até 64 KB.
- Ao conectar envia `agent.hello.v1` (versão e capacidades; por ora nenhuma, até haver aparelhos habilitados).
- Reconexão com espera exponencial e variação aleatória (1 s, 2, 4 ... teto de 30 s), **sem limite de
  tentativas**; a espera volta ao início depois de 60 s de conexão estável.
- Credencial recusada (401/403 na abertura ou fechamento 4403 `revoked`): **para**, avisa para rodar
  `uniover-agent pair` e mantém o token no cofre até o usuário decidir. Fechamento 4409 `replaced` (outra instância do
  mesmo agente assumiu): espera 60 s antes de tentar de novo.
- `status` não abre o canal (uma segunda conexão derrubaria a do agente em execução): confere só se a API responde.

## O que é validado

Toda mensagem recebida passa pelo `EnvelopeGate` **antes de qualquer efeito**: JSON válido, envelope e corpo
contra o JSON Schema do `type` (cópias em `contracts/schemas/`), modelo tipado, `source` igual a `api` e `target`
igual a este agente. Mensagem inválida, de `type` desconhecido ou de versão não suportada **nunca é executada**: vai
para o log (agente, `type` e motivo, sem o corpo) e, se houver `correlationId`, a API recebe `command.result.v1`
com `ok:false` e `error.code = "invalid_message"`. O que o agente envia também é validado antes de sair. Os logs
nunca trazem token, `deviceCode`, cabeçalhos nem corpo completo (as bibliotecas de rede ficam em `WARNING`).

## Arquitetura

- `core/`: casos de uso (`HandleCommand`, `ProcessMessage`, `ConnectionSupervisor`, `PairAgent`) e o `EnvelopeGate`.
- `ports/`: `Transport`, `SecretStore`, `PairingClient`, `Clock`, `TvRemote` como `typing.Protocol`.
- `adapters/`: `transport_ws`, `secret_store_keyring`, `pairing_http`, `system_clock`, `local_config` e dublês de teste.
- `contracts/`: modelos e esquemas gerados, não editar.
- `main.py`: composição e linha de comando.

Trocar de transporte (MQTT, depois) é trocar o adaptador: o núcleo não sabe que existe WebSocket.

## Regra do núcleo

`core/` e `ports/` nunca importam `adapters/` nem biblioteca de rede, de cofre ou de TV. O `import-linter`
(`uv run lint-imports`) falha se isso acontecer.

## Ainda fora daqui

Iniciar sozinho com o Windows e empacotar; controle da TV; adaptador MQTT.
