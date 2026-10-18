# 0010. Eventos de integração por porta própria com outbox em Postgres; broker depois

- **Status:** Aceito
- **Data:** 18/10/2026

## Contexto

Um módulo precisa reagir ao que acontece em outro sem chamá-lo diretamente e sem acessar o banco dele
(ADR 0002 e 0009). Publicar um evento depois de gravar no banco, em duas etapas, pode perder o evento se o
processo cair entre as duas. Um broker dedicado resolveria, mas custa dinheiro e operação antes de haver
necessidade medida.

## Decisão

- Existe a porta `IEventBus` (`PublishAsync(IIntegrationEvent)`) em `BuildingBlocks.Messaging`.
- O adaptador atual é uma **outbox** na tabela `<schema>.outbox_messages` do módulo que publica, gravada na
  **mesma transação** dos dados. Um `BackgroundService` lê com `FOR UPDATE SKIP LOCKED`, entrega aos
  assinantes, repete com backoff e move para `dead_letters` após N tentativas.
- Quem assina registra uma **inbox** com o id do evento, para ser idempotente: entrega ao menos uma vez,
  efeito uma vez.
- O evento tem nome versionado (`tv.state-changed.v1`), vive em `*.Contracts` e é imutável depois de
  publicado; mudança incompatível é versão nova.
- Um broker (RabbitMQ na CloudAMQP) entra apenas como outro adaptador da mesma porta, com ADR e motivo
  medido.

A fila offline do celular (Dexie) é outra coisa: mora no PWA e sincroniza por HTTP idempotente.

## Consequências

- Sem perda de evento por queda entre gravar e publicar.
- Nenhum serviço novo para operar agora; migrar para broker é trocar o adaptador.
- Todo assinante precisa ser idempotente, e a outbox precisa de monitoramento (atraso e dead letters).

## Alternativas consideradas

- **Broker desde já:** custo e operação sem necessidade medida.
- **Eventos em memória sem outbox:** perdem mensagens em caso de queda.
- **Chamada direta entre módulos:** cria o acoplamento que o projeto quer evitar.
