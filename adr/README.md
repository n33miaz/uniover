# Decisões de arquitetura (ADRs)

Um ADR (*Architecture Decision Record*) é um texto curto que registra **uma** decisão de arquitetura, o
motivo dela e o que se ganha e se perde com ela. Serve para que, meses depois, qualquer pessoa entenda por
que o código é como é, sem precisar adivinhar.

## Como propor um ADR

1. Copie `0000-template.md` para `NNNN-titulo-curto.md`, com o próximo número livre.
2. Preencha Contexto, Decisão, Consequências e Alternativas consideradas. Seja breve: 20 a 50 linhas.
3. Marque o Status como `Proposto` e abra o PR junto com (ou antes de) o código que depende da decisão.
4. Com a aprovação do dono, o Status passa a `Aceito`.
5. ADR aceito não se reescreve. Para mudar uma decisão, crie um ADR novo e marque o antigo como
   `Substituído por NNNN`.

## Índice

| # | Decisão | Status |
|---|---|---|
| [0001](0001-registrar-decisoes-em-adrs.md) | Registrar decisões de arquitetura em ADRs | Aceito |
| [0002](0002-monolito-modular.md) | Monólito modular com módulos extraíveis | Aceito |
| [0003](0003-fatias-verticais-e-portas.md) | Fatias verticais com portas e adaptadores dentro de cada módulo | Aceito |
| [0004](0004-monorepo-e-contracts.md) | Monorepo com `contracts/` como fonte de verdade entre linguagens | Aceito |
| [0005](0005-api-dotnet-e-agente-python.md) | API em .NET 10 e agente em Python | Aceito |
| [0006](0006-pwa-angular.md) | PWA em Angular 22 com Workbox, servido pela própria API | Aceito |
| [0007](0007-agente-por-websocket.md) | Agente local que disca para fora por WebSocket; MQTT depois | Aceito |
| [0008](0008-contrato-do-agente.md) | Contrato do agente: envelope versionado, JSON Schema e AsyncAPI | Aceito |
| [0009](0009-postgres-schema-por-modulo.md) | Postgres (Neon) com um schema e um DbContext por módulo | Aceito |
| [0010](0010-eventos-com-outbox.md) | Eventos de integração por porta própria com outbox em Postgres | Aceito |
| [0011](0011-autenticacao.md) | Autenticação: senha, JWT curto, refresh rotativo, passkey e token de dispositivo | Aceito (exceção em 0015) |
| [0012](0012-material-de-terceiros.md) | Material de terceiros com licença própria | Aceito |
| [0013](0013-fluxo-de-git.md) | Fluxo de git: `develop` e `main` protegidas, Conventional Commits | Aceito |
| [0014](0014-csp-com-nonce.md) | CSP estrita com nonce por requisição | Aceito |
| [0015](0015-recuperacao-do-refresh.md) | Recuperação do refresh cuja resposta se perdeu, com prova da chave do aparelho | Aceito |
| [0016](0016-atualizacao-do-agente.md) | Atualização do agente: canal, pacote conferido, prova antes de confiar | Proposto |
