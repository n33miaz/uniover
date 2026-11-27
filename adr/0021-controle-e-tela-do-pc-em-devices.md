# 0021. Controle e tela do PC como fatia de Devices

- **Status:** Proposto
- **Data:** 26/11/2026

## Contexto

A tabela de módulos apresentava `PcControl` como um módulo separado. Na API, o controle e a tela do PC
já estão em `Devices/Features/PcControl`. O [registro de Devices][module] compõe os serviços, as
políticas e as rotas da fatia. O canal WebRTC mantém o [prefixo público legado][rtc-routes]
`/api/v1/pc/rtc`, registrado fora do grupo `/api/v1/devices`.

A fatia usa o cadastro e a presença do agente pareado para resolver o [PC de destino][support].
A oferta WebRTC usa o mesmo gateway de agentes, e a auditoria do PC grava no `DevicesDbContext`.
O [registro de sessões][sessions] mantém o vínculo da sessão de tela com uma sessão ativa de controle
do mesmo usuário, agente e família de login.

## Decisão

Manter o controle e a tela do PC como uma fatia de `Devices`. O escopo `screen` usa uma sessão WebRTC
própria vinculada à sessão de controle. Para conceder o escopo `tv`, a fatia consulta
`ITvDirectChannels.ResolveAsync`, de `Tv.Contracts`. O módulo `Tv` verifica as permissões e a
visibilidade da TV para o usuário. A concessão depende de um destino autorizado para o agente da sessão.

## Consequências

A sinalização, a reconexão e a revogação continuam junto ao ciclo de vida do agente. O registro das
sessões e a auditoria do PC continuam sob responsabilidade de `Devices`. A fatia acompanha o ciclo de
publicação de `Devices`.

Na implementação atual, `Devices` chama [`ITvDirectChannels.RecordUseAsync`][tv-trail] diretamente
para registrar a abertura do canal com escopo `tv` e, quando disponíveis, as contagens de uso no fechamento.
`Tv` enfileira as entradas em memória para gravação em segundo plano. É um registro de melhor esforço.
Se a fila estiver cheia ou a gravação falhar, a entrada pode se perder e o canal segue. Na chamada
direta, `Devices` absorve falhas do registro e propaga o cancelamento da operação. A regra do
[ADR 0002](0002-monolito-modular.md) para efeitos entre módulos continua aplicável e exige evento de
integração com outbox transacional.

## Alternativas consideradas

- **Extrair `PcControl` como módulo agora.** Exigiria definir contratos para resolução e presença do
  agente, sinalização, reconexão e auditoria. Revisitar a extração quando houver necessidade concreta de
  deploy ou escala independente, ou quando o controle e a tela tiverem um ciclo de vida próprio.
  Para extrair, explicitar essas fronteiras e o dono do estado e da auditoria, sem acesso direto ao
  `DevicesDbContext`, conforme o [ADR 0002](0002-monolito-modular.md). Além de encaminhar o prefixo
  do módulo extraído, o proxy deve preservar `/api/v1/pc/rtc` e encaminhá-lo ao host que passar a
  hospedar a fatia, para manter a compatibilidade com os clientes existentes.

[module]: ../apps/api/src/Modules/Devices/UniOver.Modules.Devices/DevicesModule.cs
[rtc-routes]: ../apps/api/src/Modules/Devices/UniOver.Modules.Devices/Features/PcControl/PcRtcEndpoints.cs
[support]: ../apps/api/src/Modules/Devices/UniOver.Modules.Devices/Features/PcControl/PcControlSupport.cs
[sessions]: ../apps/api/src/Modules/Devices/UniOver.Modules.Devices/Features/PcControl/PcRtcSessions.cs
[tv-trail]: ../apps/api/src/Modules/Devices/UniOver.Modules.Devices/Features/PcControl/PcRtcTv.cs
