# contracts

Fonte de verdade entre API (C#), agente (Python) e web (TypeScript). Tipos gerados a partir daqui nunca são
editados à mão.

- `agent/envelope.schema.json`: envelope único (`v`, `id`, `type`, `source`, `target`, `ts`, `correlationId`, `body`).
- `agent/messages/*.schema.json`: um esquema por `type`; fixa o `type` e o `body`.
- `agent/asyncapi.yaml`: AsyncAPI 3.0; WebSocket hoje, MQTT declarado como futuro (mesmo envelope).
- `agent/examples/valid` e `invalid`: exemplos usados pela validação (válido deve passar, inválido deve falhar).
- `http/`: `openapi.json` gerado pela API; não editar à mão.
- `scripts/validate.mjs`: compila os esquemas e confere os exemplos.

## Versionamento de `type`

Formato `<area>.<acao>.v<n>`. Mudança incompatível cria um novo `type` (`.v2`); nunca altere o significado de
um `type` publicado. As duas versões convivem até o agente atualizar.

## Mensagens da TV

`agent.keepalive.v1` e `api.keepalive.v1` são batimentos sem corpo, a cada 25 segundos, para atravessar proxies
que descartam conexões WebSocket ociosas. O agente anuncia a capacidade `transport.keepalive.v1`; enquanto ela não
existe, a API não envia o batimento novo para preservar a compatibilidade durante a atualização.

| `type` | Direção | Corpo |
|---|---|---|
| `tv.key.v1` | API para agente | `key` (14 teclas). Segue válido e inalterado. |
| `tv.key.v2` | API para agente | `key` (as 14 do `v1` mais `MENU`, `NUM_0` a `NUM_9`, `MEDIA_NEXT`, `MEDIA_PREVIOUS`, `INPUT`) e `direction` opcional (`SHORT`, padrão, `START_LONG`, `END_LONG`). |
| `tv.key.v3` | API para agente | `key` (as do `v2` mais `INFO`, `GUIDE`, `TOOLS`, `CHANNEL_LIST`, `PREVIOUS_CHANNEL`, `EXIT`, `PLAY`, `PAUSE`, `STOP`, `REWIND`, `FAST_FORWARD`, `RED`, `GREEN`, `YELLOW`, `BLUE`, `SUBTITLE`, `ASPECT`, `SLEEP`, `E_MANUAL`) e `direction` opcional. A API só a usa para as teclas que o `v2` não tem, e o agente que a entende declara a capacidade `tv.key.v3`. |
| `tv.power.off.v1` | API para agente | `{}`: desligar de forma segura. O agente lê a energia da TV, só aperta `POWER` se ela estiver ligada e confirma o desligamento; nunca liga a TV. Responde com `command.result.v1`: `ok: true` é `off`; `ok: false` traz `error.code` `already_off`, `uncertain` (não deu para ler ou confirmar; nenhuma tecla foi repetida), `offline` ou `failed`. A API só a usa quando o agente declara a capacidade `tv.power.off.v1`; sem ela segue o `tv.key.v2` com `POWER`. |
| `tv.wake.v1` | API para agente | `{}`: o app está aberto, aqueça a sessão. |
| `tv.app.launch.v1` | API para agente | `target`: `{ kind: "package" | "link", value }`. Pacote: nome Android com pontos (até 255); link: `esquema://...` sem espaços nem controles (até 2048). |
| `tv.apps.refresh.v1` | API para agente | `{}`: pede a lista de apps. |
| `tv.apps.v1` | agente para API | `apps`: lista de `{ package, label | null }` (até 500) e `at` (UTC). |
| `tv.apps.v2` | agente para API | Como o `v1`, mais `icon` opcional por app: `{ mime: "image/png" | "image/webp", data }` (base64, até 32768 bytes). A lista é sempre completa; app sem `icon` mantém o que a API já guarda. O `v1` segue válido. |
| `tv.text.v1` | API para agente | `text`: 1 a 200 caracteres, sem caracteres de controle. |
| `tv.watchdog.v1` | agente para API | `kind`, `severity` (`info`, `warn`, `error`), `detail` (até 200), `attempts`, `at`. |
| `tv.cleanup.v1` | API para agente | `requestId` (UUID gerado pela API): fecha os apps abertos na TV e libera memória pelo ADB, sem derrubar o controle remoto. |
| `tv.cleanup.result.v1` | agente para API | O que a limpeza fez: `requestId` (o do pedido), `closedApps`, `memoryBeforeMb`, `memoryAfterMb` e `freedMb` (inteiros, ou `null` quando a memória não pôde ser lida; `freedMb` nunca é negativo), `failedSteps` (etapas que não deram certo, como `force-stop:com.exemplo.app`) e `at`. |
| `tv.permission.request.v1` | API para agente | `{}`: pede à TV Samsung a permissão do UniOver (o aviso "Permitir" na tela da TV). É o único jeito de o agente fazer esse pedido: ele nunca o repete sozinho. Responde logo com `command.result.v1` (`ok: true` é "o aviso foi pedido"; erros `unsupported`, `tv_unreachable`, `permission_in_progress`) e depois manda `tv.permission.v1`. A API só a usa quando o agente declara a capacidade `tv.permission.v1`. |
| `tv.permission.v1` | agente para API | `state` (`needed`: a TV não reconhece mais o UniOver e o agente parou de tentar sem pedir de novo em silêncio; `granted`: a TV aceitou) e `at`. Sai quando o estado muda e outra vez depois de cada `hello`. |
| `tv.discover.v1` | API para agente | `requestId` (UUID gerado pela API): procura as TVs compatíveis na rede local do computador (só leitura de identificação). Responde com `tv.discovery.v1` e depois `command.result.v1`. A API só a usa quando o agente declara a capacidade `tv.discovery.v1`. |
| `tv.discovery.v1` | agente para API | `requestId` (o do pedido), `tvs` (até 50 de `{ id, kind, name | null, controlled }`; `id` é opaco e estável, nunca o IP nem o MAC, e `controlled` diz se é a TV que o agente já controla) e `at`. Sai antes do `command.result.v1` do mesmo comando (`correlationId` = id do comando). |

## Manutenção remota

Só o administrador, e só por agente: ver o registro e pedir ao agente que se atualize ou reinicie. As capacidades
`agent.logs.v1` e `agent.maintenance.v1` (no `agent.hello.v1`) dizem se o agente sabe fazer; sem elas a API não manda
o pedido e a tela diz para atualizar o agente. O `hello` também pode trazer `os` (sistema do PC) e `tv` (`kind` e `host`
da TV que ele controla) e `update` (o estado da auto-atualização, abaixo), todos opcionais.

| `type` | Direção | Corpo |
|---|---|---|
| `agent.logs.request.v1` | API para agente | `requestId` (UUID gerado pela API) e `lines` (1 a 1000). Nunca leva caminho: o agente lê só o próprio arquivo de registro. |
| `agent.logs.v1` | agente para API | `requestId` (o do pedido), `text` (até 49152 caracteres, já sem tokens, `Authorization`, códigos de pareamento e senhas), `lines`, `truncated` (o agente tirou linhas antigas para caber) e `at`. |
| `agent.maintenance.v1` | API para agente | `action`: `update` (o supervisor roda a auto-atualização agora; o agente só reinicia se houver versão nova) `restart` (o supervisor reinicia o agente) ou `rollback` (o supervisor volta para a versão anterior guardada em `app.previous`, bloqueia a que sai e reinicia; o agente recusa com `no_previous_version` se não houver). |
| `agent.update.status.v1` | agente para API | O estado da auto-atualização, o mesmo objeto de `update` no `hello`: `outcome` (`not_checked`, `updating`, `updated`, `up_to_date`, `failed`, `blocked` ou `rolled_back`), `installedSha` e `installedAt` (a versão instalada), `latestSha` (o commit mais novo que a última checagem viu), `checkedAt`, `nextCheckAt`, `reason` (curto, já sem segredos, até 200 caracteres), `blockedSha` (versão que caiu repetidamente) e `rolledBack` (houve volta à versão anterior). Só `outcome` é obrigatório. O agente manda quando a checagem roda; agente antigo não manda nada e a tela diz "versão desconhecida". |

## Diagnóstico do agente

O agente guarda num arquivo local (limitado, sem duplicar) os erros e as ocorrências dele mesmo (queda do processo, tarefa de fundo que falhou, reparo feito, atualização recusada) e os envia depois do `hello`. A capacidade `agent.diagnostics.v1` diz que ele sabe. O texto já chega sem caminhos, endereços, nomes de usuário e segredos; a API guarda por pouco tempo e só o administrador vê, em Sistema.

| `type` | Direção | Corpo |
|---|---|---|
| `agent.diagnostics.v1` | agente para API | `events` (1 a 20, na ordem em que aconteceram): `id` (UUID, a API ignora repetidos), `at`, `kind` (`a-z`, `0-9`, `_` e `.`, até 48), `severity` (`info`, `warn`, `error`), `component` opcional (até 32), `detail` (1 a 300 caracteres, já sem dados pessoais) e `count` opcional (quantas vezes a mesma ocorrência se repetiu antes do envio). Sem resposta: o agente apaga o que enviou. |

Como na limpeza da TV, `agent.logs.v1` sai **antes** do `command.result.v1` do mesmo comando. `agent.maintenance.v1` só é
respondido com `command.result.v1`, assim que o pedido foi entregue ao supervisor do Windows (o mesmo mecanismo do menu da
bandeja). O agente reinicia por conta do supervisor, nunca por um código de saída do próprio processo.

As teclas opcionais que a TV de fato tem são declaradas no `agent.hello.v1` como `tv.key.<TECLA>` (por exemplo `tv.key.INPUT`,
`tv.key.GUIDE`): é essa lista que o app usa para oferecer os botões extras, e uma TV sem a capacidade não os mostra.

O transporte recusa mensagens acima de 64 KB. Por isso o agente pode mandar a mesma lista de `tv.apps.v2` mais de uma vez, cada mensagem
levando só parte dos ícones.

Os resultados voltam em `command.result.v1` (com `correlationId` igual ao `id` do comando). Nenhum corpo traz segredo.

A limpeza da TV é o único comando cujo resultado carrega dados: o agente manda `tv.cleanup.result.v1` **antes** do
`command.result.v1` do mesmo comando (a API trata os quadros de um agente em ordem) e o `requestId` é o que liga os dois,
porque a API não conhece o `id` do envelope que ela mesma monta. Se o ADB não responde, só sai `command.result.v1`
com `ok: false`.
O formato do `type` aceita dois ou mais segmentos antes da versão (`tv.app.launch.v1`). Os esquemas só fixam o
formato; quem decide o que pode ser aberto (por exemplo, quais esquemas de link) é o agente.

## Como validar

```
npm ci
npm run validate
```

## Configuração do launcher da TV

`tv-launcher/config.v1.schema.json` descreve o `config.json` que o agente grava na TV e que o APK de
`apps/tv-launcher` lê (relógio, papel de parede, apps visíveis e ordem, ícones, Modo Dormir). Não é uma mensagem
do envelope: vive à parte, sem tipos gerados, e o `npm run validate` confere os exemplos de
`tv-launcher/examples/valid` (todos passam) e `examples/invalid` (todos falham). O launcher lê os mesmos exemplos nos
seus testes.

- Versão no próprio arquivo (`"schema": 1`). Mudança incompatível cria `config.v2.schema.json`; o launcher ignora um
  arquivo de versão que não conhece e segue com o que já tinha.
- O esquema é estrito para quem escreve (campo desconhecido é erro). O launcher é tolerante ao ler: ignora campo
  desconhecido e volta ao padrão num valor inválido, para uma home nunca cair por causa de um arquivo mal escrito.
- `revision` cresce a cada escrita; com duas vias de entrega (arquivo e broadcast), vale a maior.

## Geração

`contracts/` é a fonte de verdade: tudo que as três linguagens usam sai daqui, nunca é editado à mão e leva no
topo o cabeçalho "GERADO por `npm --prefix contracts run generate` — não editar".

```
npm --prefix contracts ci
npm --prefix contracts run generate   # valida, gera e grava os arquivos
npm --prefix contracts run check      # gera numa pasta temporária e falha se algo versionado divergir
```

O que o `generate` produz, nesta ordem:

| Alvo | Saída | Ferramenta (versão fixa) |
|---|---|---|
| OpenAPI | `contracts/http/openapi.json` | teste de integração `OpenApiContractTests` (sobe o Host em Development, sem banco; chaves ordenadas, sem servidores, `info.version` fixa) |
| C# | `apps/api/src/UniOver.BuildingBlocks.AgentProtocol/Generated/` | `quicktype` 26.0.0 (SystemTextJson), um arquivo por `type`, mais `AgentMessageTypes` |
| Python | `apps/agent/src/uniover_agent/contracts/` (modelos pydantic, `registry.py`, cópia dos esquemas em `schemas/`) | `datamodel-code-generator` 0.86.0 via `uvx` |
| TypeScript (HTTP) | `apps/web/src/app/core/api/generated/schema.ts` | `openapi-typescript` 7.13.0 |
| TypeScript (mensagens) | `apps/web/src/app/core/api/generated/agent/*.ts` | `json-schema-to-typescript` 16.0.0 |

Regras de uso:

- Mudou um esquema em `agent/` ou um endpoint da API? Rode o `generate` e inclua os arquivos gerados no mesmo commit.
  O `check` roda na esteira (`contracts-sync`) e reprova qualquer diferença, inclusive arquivo que sobrou sem fonte.
- Os esquemas ficam embutidos no assembly `UniOver.BuildingBlocks.AgentProtocol`; o `AgentEnvelopeValidator`
  (JsonSchema.Net) valida por eles. Os modelos pydantic não reproduzem `if/then/else` do JSON Schema: a validação
  completa no agente é a do `jsonschema` sobre `contracts/schemas/`.
- Precisa do .NET (versão do `apps/api/global.json`), Node 24 e `uv`.
