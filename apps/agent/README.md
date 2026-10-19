# uniover-agent

Agente local do UniOver (Python 3.14). Roda no PC como processo do usuário e **disca para fora**, para a API:
nunca abre porta.

## Comandos

```
uv sync
uv run uniover-agent pair      # pareia este PC com um código curto
uv run uniover-agent run       # conecta e roda em primeiro plano (é o padrão)
uv run uniover-agent status    # diz se há token no cofre e se a API responde
uv run uniover-agent tv-pair --host <ip-da-tv>   # pareia o agente com a TV (código mostrado na tela)
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
| `UNIOVER_TV_HOST` | endereço (IP) da TV; sem ele o agente não controla TV. O IP não é garantidamente fixo |
| `UNIOVER_TV_CLIENT_NAME` | nome do agente que aparece na TV no pareamento (padrão `UniOver`) |
| `UNIOVER_TV_NAME` | nome da pasta do certificado desta TV (padrão `tv`) |
| `UNIOVER_TV_HIBERNATE_SECONDS` | segundos sem comando até a sessão com a TV hibernar (padrão `300`) |

Arquivo local (fora do repositório): `%LOCALAPPDATA%\UniOver\agent.toml`, com `api_url` e `agent_id`. Nunca
guarda segredo.

## TV (Android TV Remote v2)

O agente controla a TV pelo protocolo Remote v2 (biblioteca `androidtvremote2` 0.3.2), com a **sessão
quente**: a conexão fica aberta para o app não esperar ao abrir, e **hiberna depois de 300 s sem comando e
sem aviso de "app aberto"** (`tv.wake.v1`). O primeiro comando depois de hibernar reabre a sessão; o tempo de
aquecimento é medido e registrado no log. Se a TV não responder, tenta de novo com espera de 1, 2 e 4 s e
então responde `tv_unreachable`: nunca fica num laço infinito.

Pareamento (uma vez):

1. Deixe a TV ligada. Rode `uv run uniover-agent tv-pair --host <ip-da-tv>`.
2. A TV mostra um código de 6 caracteres; digite-o quando o comando pedir.
3. O par certificado/chave fica em `%LOCALAPPDATA%\UniOver\tv\<nome>\` (`cert.pem` e `key.pem`), numa pasta
   restrita ao seu usuário (`icacls`). **Nunca** vai para o repositório nem para o log.
4. Defina `UNIOVER_TV_HOST` (ou `tv_host` no `agent.toml`) e rode `uniover-agent run`. O agente só declara a
   capacidade `tv.remote` à API se o endereço estiver definido **e** o certificado existir.

Comportamentos que valem saber:

- **Dormir não é desligar.** Hibernando, o estado publicado é `connection: hibernating` e `power: unknown`; o
  agente nunca afirma "TV desligada" só porque a sessão dormiu.
- **Um dono da conexão por TV.** Só o `TvSessionManager` abre e fecha canais. O vigia legado (tarefa agendada
  do PC que religa o serviço do controle por ADB) **precisa ser desligado quando este agente assumir**: dois
  clientes na mesma TV derrubam um ao outro. O nome da tarefa se descobre no PC de casa com
  `Get-ScheduledTask`, e quem decide quando desligar é o dono.
- **`POWER` é recusado** (`key_blocked`): sem infravermelho a TV não volta do standby e não tem botão físico.
  O desligamento só existirá com confirmação forte, em outra entrega.
- **Links:** `tv.app.launch.v1` com `kind=link` só abre os esquemas `https`, `http`, `market` e `vnd.youtube`
  (`intent://`, `file://` e afins são recusados). `kind=package` responde `unsupported` até haver o canal ADB.
- A biblioteca não avisa quando a conexão cai e **descarta em silêncio** a tecla enviada depois da queda; por
  isso o adaptador vigia a queda e o gerenciador reabre a sessão (com a mesma espera de 1, 2 e 4 s).
- **TV em standby** desliga a rede e não responde nada: cada comando espera as tentativas (até ~27 s no pior
  caso: 4 tentativas de 5 s mais 1 + 2 + 4 s) e responde `tv_unreachable`. Só uma **recusa ativa** da conexão
  (porta fechada, serviço do controle morto) sinaliza `needs_repair` ao vigia; ficar sem resposta não.
- Medições na TV real (`tools/measure_tv_session.py`, somente leitura): mortes do serviço por hora com e sem
  sessão, memória e tempo de religação. Nunca envia tecla de energia. **Pare o agente e o vigia antigo antes de
  medir**: a ferramenta usa o mesmo certificado e o ADB aceita um cliente por vez.

## Conexão

- `wss://<api>/api/v1/devices/agents/<agentId>/ws`, `ping` a cada 20 s, mensagens de texto JSON de até 64 KB.
- Ao conectar envia `agent.hello.v1` (versão e capacidades: `tv.remote` com a TV configurada e pareada, senão
  nenhuma) e, em seguida, `tv.state.v1` com o estado atual da TV.
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

- `core/`: casos de uso (`HandleCommand`, `ProcessMessage`, `ConnectionSupervisor`, `PairAgent`) e o `EnvelopeGate`;
  em `core/tv/`, o `TvSessionManager` (sessão quente, hibernação, reconexão), os handlers dos comandos da TV e o
  publicador de `tv.state.v1`.
- `ports/`: `Transport`, `SecretStore`, `PairingClient`, `Clock`, `TvChannel`, `TvRemote` como `typing.Protocol`.
- `adapters/`: `transport_ws`, `secret_store_keyring`, `pairing_http`, `system_clock`, `local_config`,
  `tv_remote_v2`, `tv_pairing` e dublês de teste.
- `contracts/`: modelos e esquemas gerados, não editar.
- `main.py`: composição e linha de comando.

Trocar de transporte (MQTT, depois) é trocar o adaptador: o núcleo não sabe que existe WebSocket.

## Regra do núcleo

`core/` e `ports/` nunca importam `adapters/` nem biblioteca de rede, de cofre ou de TV. O `import-linter`
(`uv run lint-imports`) falha se isso acontecer.

## Ainda fora daqui

Iniciar sozinho com o Windows e empacotar; teclas e apps pelo canal ADB; vigia da TV; adaptador MQTT.
