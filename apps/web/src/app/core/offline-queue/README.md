# Fila de escrita offline

Toda escrita feita sem rede (ou com a API dormindo) é guardada no aparelho, no IndexedDB (Dexie, banco
`uniover-offline`), e reenviada quando houver rede. O servidor aceita o reenvio sem duplicar. A fila é genérica:
qualquer módulo a usa, sem mudar o motor.

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

| Arquivo               | Papel                                                                                                                                     |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `offline-queue.ts`    | Fachada: `enqueue`, `syncNow`, `update`, `retry`, `discard`, `items` e os signals `pendingCount`, `failedCount`, `lastSyncAt`, `syncing`. |
| `sync-engine.ts`      | Motor de envio: um item por vez, FIFO, trava entre abas, gatilhos e temporizadores.                                                       |
| `outbox-store.ts`     | Tudo que toca o IndexedDB; mudanças dependentes do estado anterior em transação de leitura e escrita.                                     |
| `classify-result.ts`  | Função pura que decide o que fazer com o resultado de um envio.                                                                           |
| `queue-transport.ts`  | Porta de saída (`HttpClient` por padrão, então os interceptadores de conexão e de autenticação valem).                                    |
| `queue-ports.ts`      | Relógio, temporizadores e bloqueio entre abas, injetáveis (o teste troca por versões falsas).                                             |
| `sync-status-line.ts` | Componente só apresentacional: "N ainda não sincronizados", "sincronizado às HH:MM", "N com erro".                                        |
| `uuid-v7.ts`          | Gerador de UUID v7 (ordem estrita, mesmo no mesmo milissegundo).                                                                          |

O motor precisa ser iniciado na partida do app (`SyncEngine.start()` num inicializador): é ele que hidrata o
banco e reenvia o que ficou pendente de antes. `enqueue` também o inicia, mas um aparelho aberto sem nenhuma
escrita nova não reenviaria nada se ninguém o iniciasse.

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

- **Um envio por vez** na aba e **uma aba por vez** (`navigator.locks`, com _fallback_ para uma execução por aba).
- **FIFO**. Erro de infraestrutura interrompe a passagem e agenda a próxima, para não furar a fila nem martelar
  o servidor: rede, 5xx, 408, 502/503 do Render acordando, 429 (respeita `Retry-After`) e 409
  `idempotency-in-progress` voltam com _backoff_ `min(2 s × 2^n, 5 min)` e jitter de ±20%. **Nunca desiste por
  tempo.**
- **401** mantém o item (pendente, sem contar como falha) e espera sessão: a renovação é do interceptador.
- **Recusa de negócio** (400, 404, 422 e outros 4xx) marca o item `failed`: continua visível para o usuário
  (`retry` ou `discard`) e **não** trava os demais.
- **A fila nunca é limpa por logout, 401 ou erro de rede.** Só um 2xx remove um item, e só se ele não mudou
  durante o voo (revisão igual). Descartar é decisão do usuário (`discard`).
- Sem sessão (`anonymous`) o motor não envia nada e não mexe em nada: a fila espera quem entrar. A fila é do
  aparelho do dono (app de um usuário só): itens gravados por uma conta serão enviados na próxima sessão.
- **Gatilhos de reenvio** (não há Background Sync no iPhone): ao gravar, no evento `online`, ao voltar para a
  aba, na partida do app, no botão "sincronizar agora" e num temporizador de 30 s que só existe com pendência e
  página visível. `online`, volta para a aba, sessão nova e o botão ignoram a espera do _backoff_; o
  temporizador e a gravação de um item novo a respeitam. Sem pendência não há temporizador (não acorda o Render
  à toa); item `failed` sozinho também não mantém nenhum.
- Estando offline (`navigator.onLine` falso) o motor não tenta nem gasta tentativa; só vira "servidor acordando"
  quem tem rede e mesmo assim não recebe resposta.
- Na partida, o que ficou `sending` (aba fechada no meio do envio) volta para `pending`, com a mesma chave.
- `navigator.storage.persist()` é pedido uma única vez (lembrado no próprio banco); erro nele é ignorado.

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
