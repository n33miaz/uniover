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
