# UniOver.Api

API modular em .NET 10 (monólito modular). Regras e motivos em [`adr/0002`](../../adr/0002-monolito-modular.md) e [`adr/0003`](../../adr/0003-fatias-verticais-e-portas.md).

## Comandos

```
dotnet build UniOver.slnx -warnaserror
dotnet test --solution UniOver.slnx
dotnet run --project src/UniOver.Host          # respeita a variável PORT quando existe
```

## Criar um módulo novo

1. Copie `src/Modules/Tv` (os dois projetos: `UniOver.Modules.<M>` e `UniOver.Modules.<M>.Contracts`).
2. Exponha `Add<M>Module` e `Map<M>Endpoints`; rotas em `/api/v1/<m>`; configuração em `Modules:<M>`.
3. Referencie só `*.Contracts` de outros módulos, `UniOver.SharedKernel` e `UniOver.BuildingBlocks.*`.
4. Registre no `Program.cs` do Host, no `UniOver.slnx` e como referência dos projetos de teste de arquitetura.
   Os testes de arquitetura descobrem o módulo pelo nome `UniOver.Modules.*`; não é preciso editá-los.
5. Linha nova na tabela de módulos da arquitetura exige ADR antes.

## Build e testes

Rode tudo a partir de `apps/api`: o `global.json` com o runner de testes mora aqui, e a partir da raiz do
repositório o `dotnet test` cai no modo antigo e recusa.

```
dotnet build UniOver.slnx -warnaserror
dotnet test --solution UniOver.slnx
dotnet test --solution UniOver.slnx --filter-namespace "*Messaging*"   # só um assunto
```

Os testes de integração precisam do **Docker** em execução: a fixture sobe um Postgres 18 por Testcontainers,
com os papéis reais (dono das migrations e papel da aplicação) e um banco isolado por teste. Sem Docker, essa
suíte não roda.

## Persistência por módulo

- Cada módulo tem o **seu schema** e o **seu `DbContext`** (herda `ModuleDbContext`). Não há `search_path` nem
  chave estrangeira entre schemas.
- O histórico de migrations fica no schema do próprio módulo (`<schema>.__ef_migrations_history`).
- A aplicação roda com um papel **sem DDL**: só DML nas tabelas do módulo, sem acesso ao histórico de migrations.
  O nome do papel vem de `UNIOVER_RUNTIME_ROLE` (padrão `uniover_app`). A primeira migration de cada módulo
  chama `RuntimeRoleGrants.Sql("<schema>")` no `Up` para conceder esses direitos.
- A conexão da aplicação é `ConnectionStrings:Default` (obrigatória fora de Development e Testing).
- `UNIOVER_MIGRATIONS_CONNECTION` é a conexão **direta com o papel dono** e serve **só para migrations** (o
  `dotnet ef` e a esteira). Nunca a coloque no ambiente da aplicação.

Criar uma migration de um módulo (exemplo com o Identity):

```
export UNIOVER_MIGRATIONS_CONNECTION="Host=localhost;Database=uniover;Username=...;Password=..."
dotnet ef migrations add NomeDaMigration \
  --project src/Modules/Identity/UniOver.Modules.Identity \
  --startup-project src/Modules/Identity/UniOver.Modules.Identity \
  --output-dir Persistence/Migrations
```

O módulo precisa ter uma fábrica de design-time (`ModuleDesignTimeFactory<T>`), que lê
`UNIOVER_MIGRATIONS_CONNECTION`. A pasta `Persistence/Migrations` de cada módulo leva um `.editorconfig` com
`generated_code = true`: sem ele a análise recusa o namespace de bloco que o `dotnet ef` gera e o build com
`-warnaserror` falha.

Scripts em `scripts/` (rode a partir de `apps/api`):

- `build-bundles.sh` (ou `build-bundles.ps1`): gera **um migration bundle por módulo** que tenha
  `Persistence/` com a fábrica de design-time, em `artifacts/bundles/<modulo>/efbundle` (autocontido,
  `linux-x64`; a pasta `artifacts/` não é versionada). Para só gerar, `UNIOVER_MIGRATIONS_CONNECTION` não precisa
  apontar para um banco real.
- `migrate-all.sh`: aplica cada bundle em ordem alfabética de módulo, usando
  `UNIOVER_MIGRATIONS_CONNECTION` (obrigatória). É o que a esteira chama.

## Borda web

Tudo isto vive em `UniOver.BuildingBlocks.Web`; o Host só compõe.

- **Erros** saem como `application/problem+json` (ProblemDetails), com `type` em
  `https://uniover.app/problems/<codigo>` e `traceId`. Exceção não tratada, validação e status sem corpo
  (404, 405, 429...) seguem o mesmo formato.
- **Limite de requisições**: quatro políticas nomeadas (`login`, `refresh`, `pairing` e `commands`), com
  valores padrão ajustáveis em `RateLimiting:<politica>`. Estouro devolve 429 com `Retry-After`. Os módulos
  aplicam a política com `.RequireRateLimiting(...)`.
- **IP real atrás de proxy**: `ForwardedHeaders:Enabled` vem **desligado**; ligue só onde há proxy confiável
  (o limite por IP depende disso).
- **Cabeçalhos de segurança**: CSP estrita sem `unsafe-inline` e com nonce por requisição (veja
  [`adr/0014`](../../adr/0014-csp-com-nonce.md)), HSTS fora de Development, `nosniff`, Referrer-Policy,
  Permissions-Policy, COOP e `Cache-Control: no-store` em `/api/*`.
- **`index.html`**: entregue pela API, que troca `__CSP_NONCE__` pelo nonce da requisição. Rotas
  desconhecidas sob `/api`, `/health` e `/openapi` dão 404 (não caem no `index.html`).

## Eventos (outbox e inbox)

Em `UniOver.BuildingBlocks.Messaging`.

- **Outbox por schema**: cada módulo que publica eventos guarda as mensagens na tabela `outbox_messages` do
  seu próprio schema, **na mesma transação** da mudança de dados. Registro com `AddModuleOutbox<TContext>` e
  tipos de evento com `AddIntegrationEvent<TEvent>("<nome versionado>")`; no mapeamento do contexto,
  `AddOutbox()`, `AddDeadLetters()` e `AddInbox()`.
- **Despachante sem consulta periódica curta**: ele acorda por sinal (a gravação de uma mensagem avisa), por
  retry já agendado e por um único relógio de reserva de `Messaging:IdlePollSeconds` (padrão 21600 s, ou
  seja, 6 h; o mínimo aceito é 60 s). Isso é deliberado: o banco do plano grátis só dorme se ficar sem
  consultas, e uma consulta a cada poucos segundos o manteria acordado o mês inteiro. Fila vazia significa
  nenhuma consulta.
- Falhas fazem retry com backoff crescente; ao passar de `Messaging:MaxAttempts` a mensagem vai para
  `dead_letters`.
- **Inbox idempotente**: o consumidor herda `IdempotentEventHandler<TContext, TEvent>`, que registra o par
  evento + consumidor no inbox na mesma gravação do efeito. Reentrega do mesmo evento é reconhecida e não
  reaplica nada.

## Autenticação

Módulo Identity, com a composição de autenticação em `UniOver.BuildingBlocks.Web/Authentication`.

- **JWT de acesso curto** (`Modules:Identity:AccessMinutes`, padrão 10 min) mais **refresh em cookie**
  `HttpOnly`, `Secure`, `SameSite=Strict`, restrito ao caminho `/api/v1/identity/auth`, com rotação a cada uso
  e detecção de reuso.
- **Política padrão "autenticado"**: todo endpoint real exige login. Rotas públicas são marcadas
  explicitamente com `.AllowAnonymous()` (hoje: `login`, `refresh` e `info` do Identity, `info` do Tv, health
  e OpenAPI em Development). Esqueceu de marcar, a rota fica fechada.
- **Sem cadastro aberto**: não existe endpoint de registro. A conta do dono é criada na partida a partir de
  `UNIOVER_OWNER_EMAIL` e `UNIOVER_OWNER_PASSWORD`, em segundo plano e sem derrubar a partida se o banco ainda
  não estiver pronto. Depois da primeira criação, remova a senha do ambiente.
- **Chave de assinatura**: `Modules:Identity:Jwt:SigningKey` (e `PreviousSigningKey` durante uma troca de
  chave). Fora de Development e Testing, sem chave válida o login recusa assinar (erro 500, explicado no log).
  Nunca versione a chave: ela vem do ambiente.

## Auditoria

Quem fez o quê, quando, de onde (IP e aparelho) e com que resultado. Só o administrador lê.

- **Cada módulo é dono da sua tabela** (`identity.login_audit`, `devices.pairing_audit`, `tv.command_audit`) e a expõe pela
  porta de leitura `IAuditSource` (`UniOver.SharedKernel.Audit`), que devolve o formato comum `AuditRecord`. O
  módulo registra a sua fonte no contêiner (`AddScoped<IAuditSource, ...>`); o Identity junta todas as registradas em
  `GET /api/v1/identity/audit` (filtros por pessoa, módulo, ação, resultado e período; paginação por cursor composto
  `(instante, fonte, id)`), `GET /api/v1/identity/audit/sources` (módulos, prazos e ações, para montar os filtros) e
  `GET /api/v1/identity/audit/export` (CSV da consulta, no máximo 5000 linhas; a exportação também fica registrada).
  A resposta traz o nome de exibição atual da conta e o id, nunca o e-mail, e nunca o conteúdo de um texto digitado na TV.
- **Só inclusão no banco.** O papel da aplicação não tem `UPDATE`, `DELETE` nem `TRUNCATE` nessas tabelas. A lista vive em
  `AppendOnlyTables` e o `RuntimeRoleGrants.Sql("<schema>")` (que toda migration de tabela chama) aplica a exceção
  **depois** dos `GRANT`, então nenhuma migration futura devolve o `DELETE`. Tabela de auditoria nova entra na lista; um
  teste falha se existir tabela com "audit" no nome fora dela. Um direito HERDADO de outro papel (o provedor do banco pode
  colocar o papel num grupo) não se desfaz com `REVOKE`: por isso o serviço de retenção confere no catálogo, a cada rodada,
  se o papel ainda escreve nessas tabelas e avisa no log.
- **Retenção por função do banco.** `<schema>.purge_audit(integer)` (uma por schema, `SECURITY DEFINER`, `search_path` fixo)
  apaga só o que passou do prazo e tem um **piso** escrito dentro dela: a aplicação não consegue apagar o recente nem
  encurtar o prazo, só estendê-lo. Prazos (constantes em `AuditRetentionPolicy`, o mesmo número é o piso nas funções): 180
  dias para segurança (login, sessão, passkey, convite, permissão, pareamento) e 30 dias para comandos da TV. Mudar um
  prazo é uma migration nova. O `AuditPurgeService` chama as funções a cada 24 h, a primeira 10 min depois da partida
  (`AuditPurge:FirstRunDelayMinutes` e `AuditPurge:IntervalHours`); sem laço curto, para o banco gratuito poder dormir.
  `tv.watchdog_events` fica de fora: é um buffer rotativo do que o agente relata, não o registro de uma ação de alguém.
- **IP confiável.** Com `ForwardedHeaders:Enabled`, vale só a **última** entrada de `X-Forwarded-For` (`ForwardLimit = 1`), a
  que o proxy da frente acrescentou; o que o cliente mandou antes dela é ignorado. Desligado (o padrão), o cabeçalho não vale nada.

## Como o `Program.cs` compõe os módulos

O Host só compõe: cada módulo é chamado explicitamente (`Add<M>Module` e `Map<M>Endpoints`), sem descoberta
por reflexão, e não define tipos próprios. Comentários-marcador mostram onde cada assunto entra:

- `// [composição: eventos]`, `// [composição: autenticação]` e `// [composição: passkeys]` marcam, em ordem, o
  ponto de registro de serviços de cada assunto.
- `// [pipeline: autenticação]` marca onde autenticação e autorização entram no pipeline de requisição (depois
  de IP real, cabeçalhos, erros, arquivos estáticos e limite de requisições).

A ordem do pipeline importa; ao mexer nela, mantenha o IP real primeiro (o limite depende dele) e os
cabeçalhos e o tratamento de erros antes de qualquer resposta.
