# 0008. Contrato do agente: envelope versionado, JSON Schema e AsyncAPI

- **Status:** Aceito
- **Data:** 18/10/2026

## Contexto

A API (.NET) e o agente (Python) trocam mensagens, hoje por WebSocket e depois possivelmente por MQTT. Se o
formato depender do transporte, trocar o transporte vira reescrita. Se as mensagens não forem validadas, um
dado malformado pode virar um comando indevido num aparelho.

## Decisão

Todas as mensagens usam um **envelope único**, igual em qualquer transporte:

```json
{ "v": 1, "id": "...", "type": "tv.key.v1", "source": "api", "target": "agent:pc-casa",
  "ts": "2026-10-18T14:00:00Z", "correlationId": null, "body": { "key": "VOLUME_UP" } }
```

Em `contracts/agent/` ficam o `envelope.schema.json`, um schema por `type` e o `asyncapi.yaml`, que descreve
canais e direção. O `type` carrega a versão (`.v1`). Uma mudança incompatível cria um `type` novo (`.v2`), e
as duas versões convivem até o agente ser atualizado.

Toda mensagem recebida é **validada contra o JSON Schema antes de executar**. Mensagem desconhecida é
recusada e registrada. Os modelos de cada lado são gerados a partir dos schemas.

## Consequências

- Trocar WebSocket por MQTT não muda o formato, só o adaptador.
- Agente e API podem ser atualizados em momentos diferentes, graças à convivência de versões.
- A validação na borda reduz o risco de comando inesperado chegar ao aparelho.
- Cada tipo de mensagem novo exige schema, exemplo e teste de contrato.

## Alternativas consideradas

- **Formato diferente por transporte:** dobra o trabalho a cada adaptador.
- **Mensagens sem versão ou sem schema:** quebram em silêncio quando um lado muda.
- **Protobuf ou gRPC:** ferramental mais pesado do que a necessidade; JSON é legível e fácil de depurar.
