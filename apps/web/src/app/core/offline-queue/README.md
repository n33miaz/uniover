# Fila de escrita offline

Toda escrita feita sem rede (ou com a API dormindo) é guardada no aparelho, no IndexedDB (Dexie, **um banco por conta**:
`uniover-offline-<id da conta>`), e reenviada quando houver rede. O servidor aceita o reenvio sem duplicar. A fila é
genérica: qualquer módulo a usa, sem mudar o motor.

```ts
const queue = inject(OfflineQueue);
const key = await queue.enqueue({
  method: 'POST',
  url: '/api/v1/<modulo>/<recurso>',
  body: { id: novoId, ... },
  module: '<modulo>',
});
```

A promessa de `enqueue` significa **guardado**, nunca **enviado**. Estar sem rede não é erro. Ela só rejeita se o
pedido for inválido (método que não é de escrita, URL fora de `/api/`) ou se o aparelho não tiver espaço
(`QueueStorageFullError`: nada foi guardado, e quem chamou precisa avisar o usuário).

## Peças

| Arquivo               | Papel                                                                                                                                                                                                       |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `offline-queue.ts`    | Fachada: `start`, `enqueue`, `syncNow`, `update`, `retry`, `discard`, `items` e os signals `pendingCount`, `failedCount`, `lastSyncAt`, `syncing`. Sempre da conta em uso (ou da conta a que foi amarrada). |
| `queue-scopes.ts`     | A fila de cada conta: abre a da conta em uso, tira a anterior de cena (sem apagar nada do disco) e adota o banco antigo.                                                                                    |
| `queue-account.ts`    | Tokens e tipos do escopo da conta (`QUEUE_ACCOUNT`, `QUEUE_BOUND_ACCOUNT`, `AccountQueue`, `QueueAccountError`).                                                                                            |
| `sync-engine.ts`      | Motor de envio de uma conta: um item por vez, FIFO, só com a sessão dela, trava entre abas por conta, gatilhos e temporizadores.                                                                            |
| `outbox-store.ts`     | Tudo que toca o IndexedDB de uma conta; mudanças dependentes do estado anterior em transação de leitura e escrita.                                                                                          |
| `classify-result.ts`  | Função pura que decide o que fazer com o resultado de um envio.                                                                                                                                             |
| `queue-transport.ts`  | Porta de saída (`HttpClient` por padrão, então os interceptadores de conexão e de autenticação valem).                                                                                                      |
| `queue-ports.ts`      | Relógio, temporizadores e bloqueio entre abas, injetáveis (o teste troca por versões falsas).                                                                                                               |
| `sync-status-line.ts` | Componente só apresentacional: "N ainda não sincronizados", "sincronizado às HH:MM", "N com erro".                                                                                                          |
| `uuid-v7.ts`          | Gerador de UUID v7 (ordem estrita, mesmo no mesmo milissegundo).                                                                                                                                            |

A fila precisa ser ligada na partida do app (`QueueScopes.follow()` num inicializador): é ela que abre o banco da conta,
hidrata os contadores e reenvia o que ficou pendente de antes, e que segue a conta quando ela muda. `enqueue` também
inicia o motor, mas um aparelho aberto sem nenhuma escrita nova não reenviaria nada se ninguém o iniciasse.

## Várias contas no mesmo navegador

O navegador é um só, mas as contas são várias (o dono testando como convidado, um aparelho emprestado). Por isso:

- **Um banco por conta**: `uniover-offline-<id>` (e o Treino, `uniover-training-<id>`). O id é o da conta em `/me` (um UUID);
  só caracteres seguros entram no nome (`accountDatabaseName`). Nada é aberto sem uma conta conhecida.
- **Qual conta?** O `/me` quando chega; antes dele (partida sem rede, servidor acordando), a **dica da última conta**
  (`uniover.account-id` no `localStorage`, junto das dicas de papel e de permissões; some ao sair). Sem dica e sem `/me` (o
  primeiro uso depois da atualização, ou depois de sair) **nenhum banco de conta é aberto**: as telas mostram só que a
  conta está sendo confirmada, e nada é lido nem gravado num banco "sem dono". A dica só escolhe o banco local; ela não
  autoriza enviar nada.
- **Trocar de conta** (o `/me` diz outra conta que a dica, ou outra pessoa entrou) não recarrega a página: a fila da conta
  anterior sai de cena (o motor para, o que estava em voo termina no banco dela, e só então o banco fecha) e a da nova
  abre do zero. Sinais, temporizadores, o "primeiro envio" e o puxador do Treino são recriados; nada passa de uma conta
  para a outra.
- **O motor só envia com a sessão da conta dona da fila.** `SessionState.isSessionOf(id)` só vale com o `/me` carregado
  (a dica não basta) e deixa de valer se outra aba do navegador entrou em outra conta (o cookie de refresh é um só). A
  conferência acontece antes de cada item e de novo depois de marcá-lo em voo. A fila de uma conta que não está com a sessão
  fica **intacta no disco** até a conta voltar: nunca é descartada, nunca sai com outro token, nunca é apagada ao sair.
- **Quem grava recebe a fila amarrada à conta dele** (`QUEUE_BOUND_ACCOUNT`): uma escrita de A que só chega depois de B
  entrar é recusada (`QueueAccountError`) em vez de cair na fila de B.
- **O banco antigo** (`uniover-offline`, de quando só havia um por aparelho) é adotado pela PRIMEIRA conta confirmada no
  aparelho depois da atualização: as linhas são copiadas para o banco dela, conferidas chave a chave, e só então o antigo é
  marcado como adotado (ele não é apagado). Recomeçar é seguro (copia só o que falta, sem duplicar nem sobrescrever o que a
  conta já mexeu). Uma segunda conta encontra o antigo adotado e começa vazia. Detalhes em `core/session/legacy-adoption.ts`.

## Convenções para quem grava na fila

1. **O id de negócio nasce no aparelho** (UUID v7) e vai no corpo. No servidor, `UNIQUE` nesse id é a **primeira**
   defesa contra duplicata; o handler continua idempotente por ele mesmo com o filtro de idempotência.
2. **`Idempotency-Key` é a rede de segurança.** A chave é o `id` do item da fila e é a mesma em **todas** as
   tentativas do mesmo item. O servidor guarda a resposta por chave (e por usuário) e a devolve no reenvio.
3. **Lápide em vez de apagar**, nos registros sincronizáveis: apagar vira uma escrita (`DELETE` ou campo
   `deleted`) que também passa pela fila, para outro aparelho não ressuscitar o registro. O motor só transporta.
4. **O relógio do cliente só desempata.** A ordem de envio é a de gravação (`createdAt` só cresce, mesmo que o
   relógio recue); conflito real se resolve no servidor.
5. **Nada de segredo na fila.** O corpo é dado do usuário, nunca credencial ou token. O token é posto pelo
   interceptador de autenticação na hora do envio.
6. **Edição de item pendente** (`update`): se o item ainda não foi tentado, mantém o id; se já foi tentado,
   ganha id novo (a mesma chave com outro corpo seria recusada pelo servidor como reuso) e mantém o lugar na
   fila. Quem estava em voo com o id antigo não consegue dar o item por enviado.

## Regras do motor

- **Um envio por vez** na aba e **uma aba por vez** (`navigator.locks`, um bloqueio por conta, `uniover-sync-<id>`, com
  _fallback_ para uma execução por aba).
- **FIFO**. Erro de infraestrutura interrompe a passagem e agenda a próxima, para não furar a fila nem martelar
  o servidor: rede, 5xx, 408, 502/503 do Render acordando, 429 (respeita `Retry-After`) e 409
  `idempotency-in-progress` voltam com _backoff_ `min(2 s × 2^n, 5 min)` e jitter de ±20%. **Nunca desiste por
  tempo.**
- **401** mantém o item (pendente, sem contar como falha) e espera sessão: a renovação é do interceptador.
- **Recusa de negócio** (400, 404, 422 e outros 4xx) marca o item `failed`: continua visível para o usuário
  (`retry` ou `discard`) e **não** trava os demais.
- **A fila nunca é limpa por logout, 401 ou erro de rede.** Só um 2xx remove um item, e só se ele não mudou
  durante o voo (revisão igual). Descartar é decisão do usuário (`discard`).
- Sem sessão (`anonymous`) o motor não envia nada e não mexe em nada: a fila espera a conta dela voltar a entrar.
- **O motor só envia com a sessão da conta dona da fila** (ver "Várias contas no mesmo navegador"), conferido a cada item.
- **Gatilhos de reenvio** (não há Background Sync no iPhone): ao gravar, no evento `online`, ao voltar para a
  aba, na partida do app, no botão "sincronizar agora" e num temporizador de 30 s que só existe com pendência e
  página visível. `online`, volta para a aba, sessão nova e o botão ignoram a espera do _backoff_; o
  temporizador e a gravação de um item novo a respeitam. Sem pendência não há temporizador (não acorda o Render
  à toa); item `failed` sozinho também não mantém nenhum.
- Estando offline (`navigator.onLine` falso) o motor não tenta nem gasta tentativa; só vira "servidor acordando"
  quem tem rede e mesmo assim não recebe resposta.
- Na partida, o que ficou `sending` (aba fechada no meio do envio) volta para `pending`, com a mesma chave.
- `navigator.storage.persist()` é pedido uma única vez por conta (lembrado no banco dela); erro nele é ignorado.

## Contrato com o servidor

Cabeçalho `Idempotency-Key: <uuid>` em `POST`, `PUT`, `PATCH` e `DELETE`.

| Situação                                              | Resposta                                                               |
| ----------------------------------------------------- | ---------------------------------------------------------------------- |
| Chave ausente ou que não é UUID                       | 400 `idempotency-key-required`                                         |
| Chave nova                                            | executa; guarda status e corpo das respostas 2xx e 4xx determinísticas |
| Falha 5xx (ou 408, 425, 429)                          | **não** guarda e libera a chave: o reenvio executa de novo             |
| Chave já concluída, mesmo pedido                      | resposta guardada, com `Idempotent-Replayed: true`                     |
| Mesma chave, pedido diferente (corpo, método ou rota) | 422 `idempotency-key-reused`                                           |
| Mesma chave ainda em andamento                        | 409 `idempotency-in-progress` com `Retry-After: 2`                     |
| "Em andamento" parado há mais de 60 s                 | conta como inexistente (o processo que a abriu caiu)                   |

Respostas com corpo acima de 32 KB guardam só o status, o `Content-Type` e o `Location`. A chave é do usuário
autenticado (outro usuário com o mesmo UUID não colide) e vale 7 dias.
