# 0021. Controle e tela do PC como fatia de Devices

- **Status:** Proposto
- **Data:** 26/11/2026

## Contexto

A tabela de módulos apresentava `PcControl` como um módulo separado. Na API, o controle e a tela do PC
já estão em `Devices/Features/PcControl`. O [registro de Devices][module] compõe os serviços, as
políticas e as rotas da fatia, incluindo a sinalização WebRTC em `/api/v1/pc/rtc`.

A fatia usa o cadastro e a presença do agente pareado para resolver o [PC de destino][support].
A oferta WebRTC usa o mesmo gateway de agentes, e a auditoria grava no `DevicesDbContext`.
O [registro de sessões][sessions] mantém o vínculo da sessão de tela com uma sessão ativa de controle
do mesmo usuário, agente e família de login.

## Decisão

Manter o controle e a tela do PC como uma fatia de `Devices`. O escopo `screen` usa uma sessão WebRTC
própria vinculada à sessão de controle. Para o escopo `tv`, a fatia usa `ITvDirectChannels` de
`Tv.Contracts`. O módulo `Tv` decide quem pode controlar a TV e mantém a trilha de uso dela.

## Consequências

A sinalização, a reconexão e a revogação continuam junto ao ciclo de vida do agente. O registro das
sessões e a auditoria continuam sob responsabilidade de `Devices`. A fatia acompanha o ciclo de
publicação de `Devices`.

## Alternativas consideradas

- **Extrair `PcControl` como módulo agora.** Exigiria definir contratos para resolução e presença do
  agente, sinalização, reconexão e auditoria. Revisitar a extração quando houver necessidade concreta de
  deploy ou escala independente, ou quando o controle e a tela tiverem um ciclo de vida próprio.
  Para extrair, explicitar essas fronteiras e o dono do estado e da auditoria, sem acesso direto ao
  `DevicesDbContext`, conforme o [ADR 0002](0002-monolito-modular.md).

[module]: ../apps/api/src/Modules/Devices/UniOver.Modules.Devices/DevicesModule.cs
[support]: ../apps/api/src/Modules/Devices/UniOver.Modules.Devices/Features/PcControl/PcControlSupport.cs
[sessions]: ../apps/api/src/Modules/Devices/UniOver.Modules.Devices/Features/PcControl/PcRtcSessions.cs
