import { OWNER_ID } from '../auth/identity-mock';
import type { IdentityMock } from '../auth/identity-mock';
import { storedAgent, storedUpdate } from '../devices/devices-mock';
import type { MockAuditItem } from '../settings/audit-mock';
import type { MockTv } from '../tv/tv-mock';
import type { Stack } from './catalog-setup';

/** Dados de mentira dos módulos de Ajustes e da TV para as telas "com dados" do catálogo. Nada aqui é de gente de verdade. */

export const CASA_ID = '11111111-1111-4111-8111-111111111111';
export const SALA_ID = '22222222-2222-4222-8222-222222222222';
const BRUNO_ID = '00000000-0000-4000-8000-000000000061';

const ANDROID_CAPS = ['tv.remote', 'tv.kind.android', 'tv.adb'];
const SAMSUNG_CAPS = ['tv.remote', 'tv.kind.samsung', 'tv.key.v3'];

const STATE = {
  power: 'on',
  volume: 22,
  app: null,
  connection: 'hot',
  agentOnline: true,
  updatedAt: '2026-10-31T12:00:00Z',
};

export function seedTvs(): MockTv[] {
  return [
    {
      id: CASA_ID,
      name: 'Casa',
      isDefault: true,
      agentSlug: 'agent:pc-de-casa',
      kind: 'android',
      online: true,
      capabilities: ANDROID_CAPS,
      state: { ...STATE },
      history: [
        {
          id: 'h3',
          userId: BRUNO_ID,
          command: 'tv.text',
          detail: 'length=5',
          ok: false,
          errorCode: 'TV_UNREACHABLE',
          occurredAt: '2026-10-31T21:40:00Z',
        },
        {
          id: 'h2',
          userId: OWNER_ID,
          command: 'tv.power-off',
          detail: null,
          ok: true,
          errorCode: null,
          occurredAt: '2026-10-31T21:10:00Z',
        },
        {
          id: 'h1',
          userId: BRUNO_ID,
          command: 'tv.key',
          detail: 'VOLUME_UP/SHORT',
          ok: true,
          errorCode: null,
          occurredAt: '2026-10-31T20:55:00Z',
        },
      ],
    },
    {
      id: SALA_ID,
      name: 'Sala',
      isDefault: false,
      agentSlug: 'agent:notebook',
      kind: 'samsung',
      online: false,
      capabilities: SAMSUNG_CAPS,
      state: { ...STATE, agentOnline: false, connection: 'disconnected', volume: null },
    },
  ];
}

/** Passkeys, convites pendentes e convidados com acessos diferentes (a lista de Pessoas e a de Segurança ficam cheias). */
export function seedAccount(identity: IdentityMock): void {
  identity.passkeys.push(
    {
      id: 'p1',
      name: 'Notebook',
      rawId: 'a',
      createdAt: '2026-09-02T12:00:00Z',
      lastUsedAt: '2026-10-18T09:00:00Z',
    },
    { id: 'p2', name: 'Celular', rawId: 'b', createdAt: '2026-10-01T12:00:00Z', lastUsedAt: null },
  );
  identity.seedInvite('Alice');
  identity.seedInvite('Dani', ['module:tv', 'tv:edit-shortcuts', 'module:training']);
  identity.guests.push(
    {
      id: BRUNO_ID,
      displayName: 'Bruno',
      email: 'bruno@exemplo.com',
      password: 'x',
      createdAt: '2026-10-10T10:00:00Z',
      disabledAt: null,
    },
    {
      id: 'g3',
      displayName: 'Bia',
      email: 'bia@exemplo.com',
      password: 'x',
      createdAt: '2026-10-12T10:00:00Z',
      disabledAt: null,
      permissions: ['module:training'],
    },
    {
      id: 'g2',
      displayName: 'Carla',
      email: 'carla@exemplo.com',
      password: 'x',
      createdAt: '2026-10-05T10:00:00Z',
      disabledAt: '2026-10-12T10:00:00Z',
    },
  );
  identity.sessions = [
    {
      id: 's1',
      userAgent:
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
      ip: '203.0.113.7',
      createdAt: '2026-10-30T10:00:00Z',
      lastUsedAt: '2026-11-01T09:00:00Z',
      isCurrent: true,
      platform: 'iphone',
      installed: false,
    },
    {
      id: 's2',
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
      ip: '198.51.100.20',
      createdAt: '2026-10-20T10:00:00Z',
      lastUsedAt: '2026-10-29T18:00:00Z',
      isCurrent: false,
      platform: 'pc',
      installed: null,
    },
  ];
}

const SAFARI =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const CHROME =
  'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';

/** Uma trilha curta e variada: entrada, tecla da TV, falha de entrada, mudança de permissão e um acesso recusado. */
export function seedTrail(): MockAuditItem[] {
  const owner = { id: OWNER_ID, displayName: 'Dono da Casa' };
  const bruno = { id: BRUNO_ID, displayName: 'Bruno' };
  const base = { target: null, targetAccount: null, detail: null };
  const rows: Omit<MockAuditItem, 'id' | 'occurredAt'>[] = [
    {
      ...base,
      module: 'identity',
      action: 'login_succeeded',
      outcome: 'success',
      actor: owner,
      ip: '203.0.113.7',
      userAgent: SAFARI,
    },
    {
      ...base,
      module: 'tv',
      action: 'tv.key',
      outcome: 'success',
      actor: bruno,
      target: 'VOLUME_UP/SHORT',
      ip: '198.51.100.20',
      userAgent: CHROME,
    },
    {
      ...base,
      module: 'identity',
      action: 'login_failed',
      outcome: 'failure',
      actor: { id: 'apagada', displayName: null },
      ip: '192.0.2.44',
      userAgent: CHROME,
    },
    {
      ...base,
      module: 'identity',
      action: 'permissions_changed',
      outcome: 'success',
      actor: owner,
      targetAccount: bruno,
      detail: '+tv:launch|-',
      ip: '203.0.113.7',
      userAgent: SAFARI,
    },
    {
      ...base,
      module: 'tv',
      action: 'tv.power-off',
      outcome: 'denied',
      actor: bruno,
      ip: '198.51.100.20',
      userAgent: CHROME,
    },
  ];
  return Array.from({ length: 18 }, (_, index) => ({
    ...rows[index % rows.length],
    id: `a${index}`,
    occurredAt: new Date(Date.UTC(2026, 10, 1, 12, 0) - index * 47 * 60_000).toISOString(),
  }));
}

/** O que cada simulador de Ajustes precisa para a tela vir cheia. */
export function seedSettings(stack: Stack): void {
  seedAccount(stack.identity);
  stack.tv.tvs = seedTvs();
  stack.tv.members[SALA_ID] = ['g3'];
  stack.audit.items = seedTrail();
  stack.system.computers.push(
    {
      slug: 'agent:pc-de-casa',
      name: 'PC de casa',
      platform: 'windows',
      online: true,
      revoked: false,
    },
    {
      slug: 'agent:notebook',
      name: 'Notebook',
      platform: 'windows',
      online: false,
      revoked: false,
    },
  );
  stack.system.current = 'agent:pc-de-casa';
  stack.system.source = 'saved';
  stack.devices.agents.push(
    storedAgent(),
    storedAgent({
      id: '00000000-0000-4000-8000-000000000002',
      slug: 'agent:notebook',
      name: 'Notebook',
      connected: false,
      lastSeenAt: '2026-10-30T20:00:00Z',
      update: storedUpdate({ state: 'pending' }),
    }),
  );
  stack.siri.keys.push({
    id: 'key-0',
    name: 'iPhone do dono',
    tvId: CASA_ID,
    tvName: 'Casa',
    actions: ['tv.power-off', 'tv.volume-up', 'tv.volume-down', 'tv.mute'],
    createdAt: '2026-10-20T10:00:00Z',
    expiresAt: '2027-04-20T10:00:00Z',
    lastUsedAt: '2026-10-29T21:00:00Z',
  });
  stack.siri.tvNames[CASA_ID] = 'Casa';
}
