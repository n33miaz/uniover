/*
 * O estado de Compras no aparelho, em funções puras. A tela mostra o que o servidor já confirmou (o retrato) com as
 * escritas ainda não enviadas por cima: um toque aparece na hora, com ou sem sinal, e quem decide um conflito é o
 * servidor (a escrita recusada some da fila e o retrato volta a valer).
 */

export interface Product {
  readonly id: string;
  readonly name: string;
  readonly section: string;
  readonly unit?: string | null;
  readonly deleted: boolean;
}

export interface ListItem {
  readonly id: string;
  readonly productId: string;
  readonly quantity: number;
  readonly note?: string | null;
  readonly needed: boolean;
  readonly deleted: boolean;
}

export interface Purchase {
  readonly id: string;
  readonly status: 'open' | 'closed';
  readonly budget?: number | null;
  readonly totalPaid?: number | null;
  readonly store?: string | null;
  readonly startedAt?: string | null;
  readonly closedAt?: string | null;
  readonly deleted: boolean;
}

export interface PurchaseItem {
  readonly id: string;
  readonly purchaseId: string;
  readonly productId: string;
  readonly quantity: number;
  readonly unitPrice?: number | null;
  readonly picked: boolean;
  readonly deleted: boolean;
}

export type EntityType = 'product' | 'listItem' | 'purchase' | 'purchaseItem';
export type Entity = Product | ListItem | Purchase | PurchaseItem;

const ENTITY_TYPES: readonly string[] = ['product', 'listItem', 'purchase', 'purchaseItem'];

export function isEntityType(value: string): value is EntityType {
  return ENTITY_TYPES.includes(value);
}

export interface Snapshot {
  readonly products: ReadonlyMap<string, Product>;
  readonly listItems: ReadonlyMap<string, ListItem>;
  readonly purchases: ReadonlyMap<string, Purchase>;
  readonly purchaseItems: ReadonlyMap<string, PurchaseItem>;
}

/** Uma linha do feed do servidor (`GET /changes`). */
export interface Change {
  readonly sequence: number;
  readonly entityType: string;
  readonly entityId: string;
  readonly payload: unknown;
}

export type OperationKind =
  'product' | 'listItem' | 'openPurchase' | 'budget' | 'closePurchase' | 'purchaseItem';

/** Uma escrita guardada no aparelho até o servidor confirmá-la. `id` é o UUID da operação: o reenvio não a repete. */
export interface PendingOperation {
  /** A ordem de gravação (dada pelo banco do aparelho); é a ordem do envio. */
  readonly seq?: number;
  readonly id: string;
  readonly kind: OperationKind;
  readonly entityId: string;
  readonly purchaseId?: string;
  readonly body: Readonly<Record<string, unknown>>;
  readonly createdAt: number;
  /**
   * Já saiu do aparelho ao menos uma vez (gravado antes do envio). Sem resposta não dá para saber se o servidor a
   * aplicou, então ela não é mais descartada junto com o "apagar" do mesmo registro (ver `ShoppingStore.enqueue`).
   */
  readonly sent?: true;
}

export function emptySnapshot(): Snapshot {
  return {
    products: new Map(),
    listItems: new Map(),
    purchases: new Map(),
    purchaseItems: new Map(),
  };
}

const TABLE: Record<EntityType, keyof Snapshot> = {
  product: 'products',
  listItem: 'listItems',
  purchase: 'purchases',
  purchaseItem: 'purchaseItems',
};

/** O retrato com um registro posto ou trocado (o original não muda). */
export function withEntity(snapshot: Snapshot, type: EntityType, entity: Entity): Snapshot {
  const table = new Map<string, Entity>(snapshot[TABLE[type]]);
  table.set(entity.id, entity);
  return { ...snapshot, [TABLE[type]]: table };
}

/** Aplica linhas do feed, na ordem. Tipo que a tela não conhece (as pessoas do grupo) é ignorado. */
export function applyChanges(snapshot: Snapshot, changes: readonly Change[]): Snapshot {
  let next = snapshot;
  for (const change of changes) {
    if (!isEntityType(change.entityType) || !change.payload || typeof change.payload !== 'object') {
      continue;
    }
    next = withEntity(next, change.entityType, {
      ...(change.payload as Entity),
      id: change.entityId,
    });
  }
  return next;
}

/** O efeito esperado de uma escrita ainda não confirmada. Espelha o que o servidor faz com ela. */
export function applyOperation(snapshot: Snapshot, operation: PendingOperation): Snapshot {
  const body = operation.body;
  const id = operation.entityId;
  switch (operation.kind) {
    case 'product': {
      const current = snapshot.products.get(id);
      return withEntity(snapshot, 'product', {
        id,
        name: String(body['name'] ?? current?.name ?? ''),
        section: String(body['section'] ?? current?.section ?? ''),
        unit: (body['unit'] as string | undefined) ?? current?.unit ?? null,
        deleted: body['deleted'] === true,
      });
    }
    case 'listItem': {
      // Num item que já existe, `only: 'needed'` mexe só no "precisa": a quantidade e a observação ficam como estão.
      const current = snapshot.listItems.get(id);
      const kept = body['only'] === 'needed' && current && !current.deleted ? current : null;
      return withEntity(snapshot, 'listItem', {
        id,
        productId: String(body['productId']),
        quantity: kept ? kept.quantity : Number(body['quantity'] ?? 1),
        note: kept ? (kept.note ?? null) : ((body['note'] as string | undefined) ?? null),
        needed: body['needed'] === true,
        deleted: body['deleted'] === true,
      });
    }
    case 'openPurchase':
      // As linhas da compra nascem no servidor; até ele responder, a compra aparece aberta e as linhas saem da lista.
      // Com outra compra já aberta no grupo, esta não aparece: o servidor só aceita uma, e é nela que tudo vai parar.
      return snapshot.purchases.has(id) || openPurchase(snapshot)
        ? snapshot
        : withEntity(snapshot, 'purchase', {
            id,
            status: 'open',
            budget: (body['budget'] as number | undefined) ?? null,
            startedAt: new Date(operation.createdAt).toISOString(),
            deleted: false,
          });
    case 'budget': {
      const purchase = snapshot.purchases.get(id);
      return purchase
        ? withEntity(snapshot, 'purchase', {
            ...purchase,
            budget: (body['budget'] as number | undefined) ?? null,
          })
        : snapshot;
    }
    case 'purchaseItem': {
      // `only` diz o que a pessoa mudou ("peguei" ou o preço); o resto fica como está, para o toque de uma pessoa não
      // apagar o preço que outra digitou. Na linha que nasce aqui, o que ela não mexeu entra neutro, como no servidor.
      const current = snapshot.purchaseItems.get(id);
      const only = body['only'];
      const kept = current && !current.deleted ? current : null;
      return withEntity(snapshot, 'purchaseItem', {
        id,
        purchaseId: operation.purchaseId ?? '',
        productId: String(body['productId']),
        quantity: only && kept ? kept.quantity : Number(body['quantity'] ?? 1),
        unitPrice:
          only === 'picked'
            ? (kept?.unitPrice ?? null)
            : ((body['unitPrice'] as number | undefined) ?? null),
        picked: only === 'price' ? (kept?.picked ?? false) : body['picked'] === true,
        deleted: body['deleted'] === true,
      });
    }
    case 'closePurchase': {
      const purchase = snapshot.purchases.get(id);
      if (!purchase || purchase.status === 'closed') return snapshot;
      let next = withEntity(snapshot, 'purchase', {
        ...purchase,
        status: 'closed',
        totalPaid: Number(body['totalPaid'] ?? 0),
        store: (body['store'] as string | undefined) ?? null,
        closedAt: new Date(operation.createdAt).toISOString(),
      });
      // O que foi pego deixa de estar pendente na lista da casa.
      const picked = new Set(
        [...next.purchaseItems.values()]
          .filter((line) => line.purchaseId === id && line.picked && !line.deleted)
          .map((line) => line.productId),
      );
      for (const item of next.listItems.values()) {
        if (item.needed && !item.deleted && picked.has(item.productId)) {
          next = withEntity(next, 'listItem', { ...item, needed: false });
        }
      }
      return next;
    }
  }
}

/** O que a tela mostra: o retrato do servidor com as escritas pendentes por cima, na ordem em que foram feitas. */
export function project(server: Snapshot, pending: readonly PendingOperation[]): Snapshot {
  return pending.reduce(applyOperation, server);
}

/** Como o servidor compara nomes de produto: sem acento, sem caixa, espaços juntos. */
export function normalizeName(value: string): string {
  return value
    .trim()
    .normalize('NFD')
    .replace(/\p{Mn}/gu, '')
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .normalize('NFC');
}

export function findProduct(snapshot: Snapshot, name: string): Product | undefined {
  const wanted = normalizeName(name);
  if (!wanted) return undefined;
  return [...snapshot.products.values()].find(
    (product) => !product.deleted && normalizeName(product.name) === wanted,
  );
}

/** Até `limit` produtos do grupo cujo nome contém o que foi digitado, os que começam por ele primeiro. */
export function suggestProducts(snapshot: Snapshot, text: string, limit = 4): readonly Product[] {
  const wanted = normalizeName(text);
  if (!wanted) return [];
  return [...snapshot.products.values()]
    .filter((product) => !product.deleted)
    .map((product) => ({ product, at: normalizeName(product.name).indexOf(wanted) }))
    .filter((match) => match.at >= 0 && normalizeName(match.product.name) !== wanted)
    .sort((a, b) => a.at - b.at || a.product.name.localeCompare(b.product.name))
    .slice(0, limit)
    .map((match) => match.product);
}

export interface ListRow {
  readonly item: ListItem;
  readonly product: Product;
}

export interface ListSection {
  readonly name: string;
  readonly rows: readonly ListRow[];
}

/** A lista da casa: só o que "precisa", por seção do mercado (a sem nome por último), em ordem alfabética. */
export function listSections(snapshot: Snapshot): readonly ListSection[] {
  const sections = new Map<string, ListRow[]>();
  for (const item of snapshot.listItems.values()) {
    const product = snapshot.products.get(item.productId);
    if (!item.needed || item.deleted || !product || product.deleted) continue;
    const rows = sections.get(product.section) ?? [];
    rows.push({ item, product });
    sections.set(product.section, rows);
  }
  return [...sections.entries()]
    .map(([name, rows]) => ({
      name,
      rows: rows.sort((a, b) => a.product.name.localeCompare(b.product.name)),
    }))
    .sort((a, b) => Number(a.name === '') - Number(b.name === '') || a.name.localeCompare(b.name));
}

export function openPurchase(snapshot: Snapshot): Purchase | undefined {
  return [...snapshot.purchases.values()].find(
    (purchase) => purchase.status === 'open' && !purchase.deleted,
  );
}

export function closedPurchases(snapshot: Snapshot): readonly Purchase[] {
  return [...snapshot.purchases.values()]
    .filter((purchase) => purchase.status === 'closed' && !purchase.deleted)
    .sort((a, b) => (b.closedAt ?? '').localeCompare(a.closedAt ?? ''));
}

/** Uma linha do modo mercado. `lineId` nulo: o produto está na lista mas ainda não tem linha na compra. */
export interface MarketRow {
  readonly lineId: string | null;
  readonly product: Product;
  readonly quantity: number;
  readonly unitPrice: number | null;
  readonly picked: boolean;
}

/**
 * As linhas da compra aberta e, depois delas, o que entrou na lista da casa sem linha na compra (posto depois de a
 * compra começar, ou ainda esperando o servidor montar as linhas). O que falta pegar vem antes do que já foi pego.
 */
export function marketRows(snapshot: Snapshot, purchase: Purchase): readonly MarketRow[] {
  const rows: MarketRow[] = [];
  const inPurchase = new Set<string>();
  for (const line of snapshot.purchaseItems.values()) {
    const product = snapshot.products.get(line.productId);
    if (line.purchaseId !== purchase.id || line.deleted || !product) continue;
    inPurchase.add(line.productId);
    rows.push({
      lineId: line.id,
      product,
      quantity: line.quantity,
      unitPrice: line.unitPrice ?? null,
      picked: line.picked,
    });
  }
  for (const item of snapshot.listItems.values()) {
    const product = snapshot.products.get(item.productId);
    if (!item.needed || item.deleted || !product || product.deleted) continue;
    if (inPurchase.has(item.productId)) continue;
    rows.push({ lineId: null, product, quantity: item.quantity, unitPrice: null, picked: false });
  }
  return rows.sort(
    (a, b) =>
      Number(a.picked) - Number(b.picked) ||
      a.product.section.localeCompare(b.product.section) ||
      a.product.name.localeCompare(b.product.name),
  );
}

const cents = (value: number): number => Math.round(value * 100);

/** O total corrente: o que já foi pego e tem preço. Somado em centavos, para 0,1 + 0,2 não virar 0,30000000000000004. */
export function pickedTotal(rows: readonly MarketRow[]): number {
  let total = 0;
  for (const row of rows) {
    if (row.picked && row.unitPrice !== null) total += cents(row.quantity * row.unitPrice);
  }
  return total / 100;
}

export interface BudgetState {
  /** Quanto falta para o teto (nunca negativo). */
  readonly left: number;
  /** Quanto passou do teto (zero enquanto cabe). */
  readonly over: number;
}

/** Como o total está em relação ao teto; `null` quando a compra não tem teto. */
export function budgetState(total: number, budget: number | null | undefined): BudgetState | null {
  if (budget === null || budget === undefined) return null;
  const difference = cents(budget) - cents(total);
  return { left: Math.max(difference, 0) / 100, over: Math.max(-difference, 0) / 100 };
}

/** O maior valor em dinheiro que o servidor aceita. */
export const MAX_MONEY = 9_999_999.99;

/**
 * Lê um valor em reais digitado ("12,5", "12.50"). Vazio é `undefined` (sem valor); texto que não é um valor aceito é
 * `null` (a tela não envia nada).
 */
export function parseMoney(text: string): number | undefined | null {
  const clean = text.trim().replace(/\s/g, '').replace(',', '.');
  if (clean === '') return undefined;
  if (!/^\d+(\.\d{1,2})?$/.test(clean)) return null;
  const value = Number(clean);
  return value <= MAX_MONEY ? value : null;
}

/** O `type` (sufixo) com que o servidor recusa abrir uma compra quando o grupo já tem uma aberta. */
export const PURCHASE_ALREADY_OPEN = 'shopping-purchase-already-open';

/**
 * As escritas de uma compra aberta neste aparelho, passadas para a compra que o servidor já tinha aberta: os itens e o
 * teto mudam de compra; o fechamento não vai junto (`dropped`), para ninguém fechar sem ver uma compra que é de todos.
 */
export function adoptPurchase(
  pending: readonly PendingOperation[],
  localId: string,
  serverId: string,
): {
  readonly changed: readonly PendingOperation[];
  readonly dropped: readonly PendingOperation[];
} {
  const changed: PendingOperation[] = [];
  const dropped: PendingOperation[] = [];
  for (const operation of pending) {
    if (operation.kind === 'purchaseItem' && operation.purchaseId === localId) {
      changed.push({ ...operation, purchaseId: serverId });
    } else if (operation.kind === 'budget' && operation.entityId === localId) {
      changed.push({ ...operation, entityId: serverId });
    } else if (operation.kind === 'closePurchase' && operation.entityId === localId) {
      dropped.push(operation);
    }
  }
  return { changed, dropped };
}

/**
 * A escrita com os ids que o servidor disse que valem: o registro dela e o produto a que ela se refere. Devolve a mesma
 * escrita quando nada muda.
 */
export function withIds(
  operation: PendingOperation,
  ids: ReadonlyMap<string, string>,
): PendingOperation {
  // O "apagar" pelo id daqui segue com ele: no servidor, apagar a cópia juntada não apaga o registro que ficou (que é de
  // outra pessoa também). Levado ao id que vale, ele apagaria esse registro.
  const entityId = operation.body['deleted'] === true ? undefined : ids.get(operation.entityId);
  const productId = ids.get(String(operation.body['productId'] ?? ''));
  if (!entityId && !productId) return operation;
  return {
    ...operation,
    ...(entityId ? { entityId } : {}),
    ...(productId ? { body: { ...operation.body, productId } } : {}),
  };
}

/**
 * O que acertar na fila depois de um envio. `ids`: registros criados aqui que o grupo já tinha (outro aparelho criou o
 * mesmo produto, o mesmo item, a mesma linha) e foram juntados; as escritas que ainda esperam passam a usar o registro
 * que vale. `purchase`: a compra aberta aqui que deu lugar à que o grupo já tinha (ver `adoptPurchase`).
 */
export function settleQueue(
  pending: readonly PendingOperation[],
  ids: ReadonlyMap<string, string>,
  purchase: { readonly from: string; readonly to: string } | null,
): {
  readonly changed: readonly PendingOperation[];
  readonly dropped: readonly PendingOperation[];
} {
  const changed = new Map<string, PendingOperation>();
  const queue = pending.map((operation) => {
    const next = withIds(operation, ids);
    if (next !== operation) changed.set(next.id, next);
    return next;
  });
  if (!purchase) return { changed: [...changed.values()], dropped: [] };
  const adopted = adoptPurchase(queue, purchase.from, purchase.to);
  for (const operation of adopted.changed) changed.set(operation.id, operation);
  for (const operation of adopted.dropped) changed.delete(operation.id);
  return { changed: [...changed.values()], dropped: adopted.dropped };
}

/**
 * As linhas de compra criadas neste aparelho, postas sobre as do servidor: uma compra tem uma linha por produto, e as
 * linhas nascem no servidor quando a compra abre. Uma escrita cuja linha o servidor não conhece passa a usar a linha
 * que ele tem para o mesmo produto; sem linha lá, todas as escritas do produto usam o id da primeira. Só entram as
 * compras que o servidor já confirmou (a que ainda espera a abertura na fila fica como está).
 */
export function alignLines(
  server: Snapshot,
  pending: readonly PendingOperation[],
): readonly PendingOperation[] {
  const serverLine = new Map<string, string>();
  for (const line of server.purchaseItems.values()) {
    if (!line.deleted) serverLine.set(`${line.purchaseId}|${line.productId}`, line.id);
  }
  const first = new Map<string, string>();
  const changed: PendingOperation[] = [];
  for (const operation of pending) {
    if (operation.kind !== 'purchaseItem' || !operation.purchaseId) continue;
    if (!server.purchases.has(operation.purchaseId)) continue;
    if (server.purchaseItems.has(operation.entityId)) continue;
    const key = `${operation.purchaseId}|${String(operation.body['productId'])}`;
    const target = serverLine.get(key) ?? first.get(key) ?? operation.entityId;
    first.set(key, target);
    if (target !== operation.entityId) changed.push({ ...operation, entityId: target });
  }
  return changed;
}

export type OperationOutcome = 'applied' | 'refused' | 'retry';

/**
 * O que fazer com o desfecho de uma operação do lote. Aplicada sai da fila. Recusada pelo servidor (dado inválido,
 * registro que não existe mais, conflito) também sai: quem decide o conflito é o servidor, e o feed traz o que vale.
 * O resto (sessão, limite de taxa, falha do servidor) fica na fila para a próxima tentativa.
 */
export function classifyResult(status: number): OperationOutcome {
  if (status >= 200 && status < 300) return 'applied';
  if (status === 400 || status === 404 || status === 409 || status === 410 || status === 422) {
    return 'refused';
  }
  return 'retry';
}
