import { BrowserContext, Route } from '@playwright/test';
import { ALL_PERMISSIONS, IdentityMock, OWNER_ID } from '../auth/identity-mock';
import { missingIdempotencyKey } from '../idempotency-guard';

const PROBLEM_BASE = 'https://uniover.app/problems/';

interface Row {
  readonly type: string;
  readonly id: string;
  readonly payload: Record<string, unknown>;
}

interface Operation {
  readonly operationId: string;
  readonly kind: string;
  readonly id: string;
  readonly purchaseId: string | null;
  readonly body: Record<string, unknown>;
}

interface Result {
  readonly status: number;
  readonly type?: string;
  readonly openPurchaseId?: string;
  /** O registro em que a operação assentou (o que o grupo já tinha, quando os dois foram juntados). */
  readonly entityId?: string;
}

const sameName = (a: unknown, b: unknown): boolean =>
  String(a ?? '')
    .trim()
    .toLocaleLowerCase('pt-BR') ===
  String(b ?? '')
    .trim()
    .toLocaleLowerCase('pt-BR');

export interface MockPerson {
  userId: string;
  name: string;
  isOwner: boolean;
  isMember: boolean;
}

export interface ShoppingMock {
  /** O que o servidor tem, por tipo (`product`, `listItem`, `purchase`, `purchaseItem`). */
  rows(type: string): readonly Row[];
  /** Outra pessoa do grupo fez isto direto no servidor. */
  put(type: string, id: string, payload: Record<string, unknown>): void;
  /** Os lotes recebidos, na ordem: `tipo:id` de cada operação. */
  readonly batches: string[][];
  /** As operações desta espécie são recusadas (409) enquanto estiver aqui. */
  refuseKind: string | null;
  people: MockPerson[];
  /** Os pedidos de pessoas: `add:<id>`, `remove:<id>`, `leave`. */
  readonly memberCalls: string[];
}

function json(route: Route, status: number, body: unknown) {
  return route.fulfill({
    status,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function problem(route: Route, status: number, kind: string) {
  return route.fulfill({
    status,
    headers: { 'content-type': 'application/problem+json' },
    body: JSON.stringify({ type: PROBLEM_BASE + kind, title: kind, status }),
  });
}

function permissionsOf(identity: IdentityMock): readonly string[] {
  const guest = identity.role === 'guest' ? identity.guests.at(-1) : undefined;
  return guest ? (guest.permissions ?? identity.guestPermissions) : ALL_PERMISSIONS;
}

/**
 * Simula a API de Compras com as regras da real que a tela usa: login e `module:shopping` em toda rota; cada operação
 * do lote aplicada uma vez só; uma compra aberta por grupo (a segunda abertura é recusada e diz qual é a aberta); as
 * linhas da compra nascem aqui, uma por item que "precisa"; uma linha por produto em cada compra. Criar o que o grupo já
 * tem (o mesmo nome de produto, o mesmo produto na lista ou na compra) junta os dois e responde 200 com o registro que
 * vale; apagar pelo id da cópia juntada responde 204 sem mudar nada.
 */
export async function mockShoppingApi(
  context: BrowserContext,
  identity: IdentityMock,
): Promise<ShoppingMock> {
  const rows = new Map<string, Row>();
  const feed: { sequence: number; entityType: string; entityId: string; payload: unknown }[] = [];
  const applied = new Map<string, Result>();
  /** O id criado num aparelho para algo que já existia aqui, e o registro que vale. */
  const merged = new Map<string, string>();
  let lines = 0;

  const put = (type: string, id: string, payload: Record<string, unknown>) => {
    rows.set(id, { type, id, payload });
    feed.push({ sequence: feed.length + 1, entityType: type, entityId: id, payload });
  };
  const of = (type: string) => [...rows.values()].filter((row) => row.type === type);

  const mock: ShoppingMock = {
    rows: of,
    put,
    batches: [],
    refuseKind: null,
    people: [
      { userId: OWNER_ID, name: 'Neemias', isOwner: true, isMember: true },
      { userId: 'u-raphael', name: 'Raphael', isOwner: false, isMember: true },
      { userId: 'u-carla', name: 'Carla', isOwner: false, isMember: false },
    ],
    memberCalls: [],
  };

  function apply(operation: Operation): Result {
    const id = merged.get(operation.id) ?? operation.id;
    const sent = operation.body;
    const productId = sent['productId'] as string | undefined;
    const body: Record<string, unknown> = productId
      ? { ...sent, productId: merged.get(productId) ?? productId }
      : sent;
    const known = rows.get(id);
    if (mock.refuseKind === operation.kind)
      return { status: 409, type: `${PROBLEM_BASE}shopping-duplicate` };
    if (body['deleted'] === true && operation.kind !== 'openPurchase') {
      if (merged.has(operation.id)) return { status: 204 };
      if (!known) return { status: 404 };
      put(known.type, id, { ...known.payload, deleted: true });
      return { status: 200, entityId: id };
    }
    switch (operation.kind) {
      case 'product': {
        const twin = of('product').find(
          (row) =>
            row.id !== id &&
            row.payload['deleted'] !== true &&
            sameName(row.payload['name'], body['name']),
        );
        if (twin && !known) {
          merged.set(id, twin.id);
          return { status: 200, entityId: twin.id };
        }
        put('product', id, { name: body['name'], section: '', deleted: false });
        return { status: 200, entityId: id };
      }
      case 'listItem': {
        const twin = of('listItem').find(
          (row) =>
            row.id !== id &&
            row.payload['deleted'] !== true &&
            row.payload['productId'] === body['productId'],
        );
        if (twin && !known) {
          merged.set(id, twin.id);
          put('listItem', twin.id, {
            ...twin.payload,
            needed: twin.payload['needed'] === true || body['needed'] === true,
            quantity: Math.max(Number(twin.payload['quantity']), Number(body['quantity'])),
          });
          return { status: 200, entityId: twin.id };
        }
        put('listItem', id, { ...body, deleted: false });
        return { status: 200, entityId: id };
      }
      case 'openPurchase': {
        if (rows.has(id)) return { status: 200 };
        const open = of('purchase').find((row) => row.payload['status'] === 'open');
        if (open) {
          return {
            status: 409,
            type: `${PROBLEM_BASE}shopping-purchase-already-open`,
            openPurchaseId: open.id,
          };
        }
        put('purchase', id, { status: 'open', startedAt: '2026-11-12T12:00:00Z', deleted: false });
        for (const item of of('listItem')) {
          if (item.payload['needed'] !== true) continue;
          put('purchaseItem', `00000000-0000-7000-8000-${String(++lines).padStart(12, '0')}`, {
            purchaseId: id,
            productId: item.payload['productId'],
            quantity: item.payload['quantity'],
            unitPrice: null,
            picked: false,
            deleted: false,
          });
        }
        return { status: 200 };
      }
      case 'budget': {
        const purchase = rows.get(id);
        if (!purchase) return { status: 404 };
        put('purchase', id, { ...purchase.payload, budget: body['budget'] });
        return { status: 200 };
      }
      case 'closePurchase': {
        const purchase = rows.get(id);
        if (!purchase) return { status: 404 };
        put('purchase', id, {
          ...purchase.payload,
          ...body,
          status: 'closed',
          closedAt: '2026-11-12T13:00:00Z',
        });
        const picked = new Set(
          of('purchaseItem')
            .filter((line) => line.payload['purchaseId'] === id && line.payload['picked'] === true)
            .map((line) => line.payload['productId']),
        );
        for (const item of of('listItem')) {
          if (picked.has(item.payload['productId'])) {
            put('listItem', item.id, { ...item.payload, needed: false });
          }
        }
        return { status: 200 };
      }
      case 'purchaseItem': {
        const purchase = rows.get(operation.purchaseId ?? '');
        if (!purchase) return { status: 404 };
        const twin = of('purchaseItem').find(
          (line) =>
            line.id !== id &&
            line.payload['purchaseId'] === purchase.id &&
            line.payload['productId'] === body['productId'],
        );
        const only = body['only'];
        if (twin && !known) {
          // Junta: "peguei" vence, a maior quantidade, e o preço se a linha que chega mexeu nele.
          merged.set(id, twin.id);
          const price = only !== 'picked' && body['unitPrice'] != null;
          put('purchaseItem', twin.id, {
            ...twin.payload,
            picked:
              twin.payload['picked'] === true || (only !== 'price' && body['picked'] === true),
            quantity: Math.max(Number(twin.payload['quantity']), Number(body['quantity'])),
            ...(price ? { unitPrice: body['unitPrice'] } : {}),
          });
          return { status: 200, entityId: twin.id };
        }
        // Na linha que nasce aqui, o que a pessoa não mexeu entra neutro; na que existe, só muda o que ela mexeu.
        const base = known ? known.payload : { unitPrice: null, picked: false };
        const fields: Record<string, unknown> = { ...body };
        delete fields['only'];
        put('purchaseItem', id, {
          ...base,
          ...fields,
          ...(only === 'picked' ? { unitPrice: base['unitPrice'] ?? null } : {}),
          ...(only === 'price' ? { picked: base['picked'] === true } : {}),
          ...(only && known ? { quantity: base['quantity'] } : {}),
          purchaseId: purchase.id,
          deleted: false,
        });
        return { status: 200, entityId: id };
      }
      default:
        return { status: 400 };
    }
  }

  await context.route('**/api/v1/shopping/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.replace('/api/v1/shopping', '');
    const method = request.method();
    const headers = request.headers();

    if (identity.offline) return route.abort('internetdisconnected');
    const bearer = headers['authorization']?.replace(/^Bearer /, '');
    if (!bearer || !identity.issuedTokens.includes(bearer)) {
      return problem(route, 401, 'unauthenticated');
    }
    if (!permissionsOf(identity).includes('module:shopping')) {
      return problem(route, 403, 'forbidden');
    }
    if (missingIdempotencyKey(method, url.pathname, headers)) {
      return problem(route, 400, 'idempotency-key-required');
    }

    const me = mock.people.find((person) => person.userId === OWNER_ID);
    const owner = me?.isOwner ?? true;
    if (method === 'GET' && path === '/group') {
      return json(route, 200, { id: 'g1', ownerUserId: OWNER_ID, isOwner: owner });
    }
    if (method === 'GET' && path === '/group/people') {
      return json(
        route,
        200,
        mock.people.filter((person) => person.isMember || owner),
      );
    }
    const member = /^\/group\/members\/([^/]+)$/.exec(path);
    if (method === 'PUT' && member) {
      const body = request.postDataJSON() as { operationId?: string; deleted?: boolean };
      const person = mock.people.find((candidate) => candidate.userId === member[1]);
      if (!person || !body.operationId) return problem(route, 404, 'not-found');
      mock.memberCalls.push(`${body.deleted ? 'remove' : 'add'}:${person.userId}`);
      person.isMember = !body.deleted;
      return json(route, 200, { userId: person.userId, isOwner: false, deleted: !!body.deleted });
    }
    if (method === 'POST' && path === '/group/leave') {
      mock.memberCalls.push('leave');
      mock.people = [{ userId: OWNER_ID, name: 'Neemias', isOwner: true, isMember: true }];
      return json(route, 200, { id: 'g2', ownerUserId: OWNER_ID, isOwner: true });
    }
    if (method === 'GET' && path === '/changes') {
      const after = Number(url.searchParams.get('after') ?? 0);
      const items = feed.filter((change) => change.sequence > after);
      return json(route, 200, {
        groupId: 'g1',
        items,
        nextCursor: items.length > 0 ? items[items.length - 1].sequence : after,
        hasMore: false,
      });
    }
    if (method === 'GET' && /^\/products\/[^/]+\/last-price$/.test(path)) {
      return route.fulfill({ status: 204 });
    }
    if (method === 'POST' && path === '/operations') {
      const body = request.postDataJSON() as { operations: Operation[] };
      mock.batches.push(body.operations.map((operation) => `${operation.kind}:${operation.id}`));
      return json(
        route,
        200,
        body.operations.map((operation) => {
          const known = applied.get(operation.operationId);
          const result = known ?? apply(operation);
          if (result.status === 200) applied.set(operation.operationId, result);
          return {
            operationId: operation.operationId,
            status: result.status,
            type: result.type ?? null,
            openPurchaseId: result.openPurchaseId ?? null,
            entityId: result.entityId ?? null,
          };
        }),
      );
    }
    return problem(route, 404, 'not-found');
  });

  return mock;
}
