import type { EntityTable } from 'dexie';

/**
 * Até quantas linhas a tabela pode ter para o merge ler a faixa de chaves inteira de uma vez. Acima disso a faixa de uma página
 * espalhada pelo tempo poderia trazer a tabela quase toda a cada página, e vale a leitura por chave (`bulkGet`).
 */
export const RANGE_READ_MAX_ROWS = 3_000;

/**
 * As linhas que o aparelho já tem para os ids de uma página vinda do servidor, indexadas por id, em **poucas requisições ao
 * banco** (não uma por linha). `bulkGet` faz uma requisição `get` por id, e o custo do IndexedDB é por requisição: no WebKit
 * do Playwright cada uma custa ~15 ms, então ler 316 exercícios e depois gravá-los (outras 316) levava ~9,5 s dentro de uma
 * transação que segura todas as outras leituras do banco. Medido ali: 500 `get` 7,6 s; um `getAll` das mesmas 500 linhas 18 ms.
 *
 * - tabela vazia (a primeira passada de um aparelho novo): nada a ler, uma contagem só;
 * - tabela até `RANGE_READ_MAX_ROWS`: uma leitura da faixa de chaves da página (`between(menor, maior)`), conferida em memória;
 * - tabela maior: `bulkGet` por id, como antes (a faixa poderia trazer linhas demais).
 *
 * Chame dentro da mesma transação que grava o resultado do merge.
 */
export async function existingRowsById<T extends { id: string }>(
  table: EntityTable<T, 'id'>,
  remote: readonly { readonly id: string }[],
): Promise<Map<string, T>> {
  const local = new Map<string, T>();
  if (remote.length === 0) return local;
  const total = await table.count();
  if (total === 0) return local;

  const wanted = new Set(remote.map((row) => row.id));
  if (total > RANGE_READ_MAX_ROWS) {
    for (const row of await table.bulkGet([...wanted] as Parameters<typeof table.bulkGet>[0]))
      if (row) local.set(row.id, row);
    return local;
  }

  let lowest: string | null = null;
  let highest: string | null = null;
  for (const id of wanted) {
    if (lowest === null || id < lowest) lowest = id;
    if (highest === null || id > highest) highest = id;
  }
  for (const row of await table.where(':id').between(lowest!, highest!, true, true).toArray()) {
    if (wanted.has(row.id)) local.set(row.id, row);
  }
  return local;
}
