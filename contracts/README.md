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

| `type` | Direção | Corpo |
|---|---|---|
| `tv.key.v1` | API para agente | `key` (14 teclas). Segue válido e inalterado. |
| `tv.key.v2` | API para agente | `key` (as 14 do `v1` mais `MENU`, `NUM_0` a `NUM_9`, `MEDIA_NEXT`, `MEDIA_PREVIOUS`, `INPUT`) e `direction` opcional (`SHORT`, padrão, `START_LONG`, `END_LONG`). |
| `tv.wake.v1` | API para agente | `{}`: o app está aberto, aqueça a sessão. |
| `tv.app.launch.v1` | API para agente | `target`: `{ kind: "package" | "link", value }`. Pacote: nome Android com pontos (até 255); link: `esquema://...` sem espaços nem controles (até 2048). |
| `tv.apps.refresh.v1` | API para agente | `{}`: pede a lista de apps. |
| `tv.apps.v1` | agente para API | `apps`: lista de `{ package, label | null }` (até 500) e `at` (UTC). |
| `tv.apps.v2` | agente para API | Como o `v1`, mais `icon` opcional por app: `{ mime: "image/png" | "image/webp", data }` (base64, até 32768 bytes). A lista é sempre completa; app sem `icon` mantém o que a API já guarda. O `v1` segue válido. |
| `tv.text.v1` | API para agente | `text`: 1 a 200 caracteres, sem caracteres de controle. |
| `tv.watchdog.v1` | agente para API | `kind`, `severity` (`info`, `warn`, `error`), `detail` (até 200), `attempts`, `at`. |

O transporte recusa mensagens acima de 64 KB. Por isso o agente pode mandar a mesma lista de `tv.apps.v2` mais de uma vez, cada mensagem
levando só parte dos ícones.

Os resultados voltam em `command.result.v1` (com `correlationId` igual ao `id` do comando). Nenhum corpo traz segredo.
O formato do `type` aceita dois ou mais segmentos antes da versão (`tv.app.launch.v1`). Os esquemas só fixam o
formato; quem decide o que pode ser aberto (por exemplo, quais esquemas de link) é o agente.

## Como validar

```
npm ci
npm run validate
```

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
