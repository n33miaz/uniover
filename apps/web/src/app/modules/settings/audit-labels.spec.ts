import {
  actorLabel,
  auditActionLabel,
  describeChange,
  describeTarget,
  formatWhen,
  formatWhenFull,
  knownActionLabel,
  moduleLabel,
  outcomeChoices,
  outcomeView,
  periodLabel,
  retentionText,
  summarizeUserAgent,
} from './audit-labels';
import { AuditItem, AuditSources } from './audit-model';

/** Todo código de ação que as três fontes da API gravam hoje (a lista do que `/audit/sources` devolve). */
const IDENTITY_ACTIONS = [
  'login_succeeded',
  'login_failed',
  'login_locked',
  'refresh_succeeded',
  'refresh_reuse_detected',
  'refresh_recovered',
  'logout',
  'owner_created',
  'passkey_registered',
  'passkey_renamed',
  'passkey_removed',
  'step_up_succeeded',
  'step_up_failed',
  'guest_invite_created',
  'guest_invite_accepted',
  'guest_invite_revoked',
  'guest_revoked',
  'guest_paused',
  'guest_resumed',
  'session_revoked',
  'permissions_changed',
  'profile_updated',
  'qr_login_approved',
  'qr_login_denied',
  'qr_login_succeeded',
  'audit_exported',
];
const DEVICES_ACTIONS = [
  'pairing_started',
  'pairing_approved',
  'pairing_denied',
  'pairing_expired',
  'pairing_token_issued',
  'agent_revoked',
  'agent_logs_viewed',
  'agent_update_requested',
  'agent_restart_requested',
  'agent_rollback_requested',
  'agent_offline',
  'agent_online',
];
const TV_ACTIONS = [
  'tv.key',
  'tv.text',
  'tv.app.launch',
  'tv.wake',
  'tv.power-off',
  'tv.cleanup',
  'tv.cleanup.setting',
  'tv.permission.request',
  'tv.discover',
  'tv.apps.refresh',
  'tv.shortcuts.reorder',
  'tv.shortcut.update',
  'tv.config.bind',
  'tv.livre.refresh',
  'tv.livre.install',
  'tv.livre.apply',
  'tv.livre.set-home',
  'tv.livre.restore',
  'tv.livre.set-apps',
  'tv.livre.sleep',
];

function item(overrides: Partial<AuditItem> = {}): AuditItem {
  return {
    id: 'a1',
    module: 'identity',
    action: 'login_succeeded',
    outcome: 'success',
    occurredAt: '2026-10-21T15:00:00Z',
    actor: { id: 'u1', displayName: 'Dono da Casa' },
    target: null,
    targetAccount: null,
    detail: null,
    ip: '203.0.113.7',
    userAgent: null,
    ...overrides,
  };
}

function sources(retention: Record<string, number | string>): AuditSources {
  return {
    outcomes: ['success', 'failure', 'denied'],
    sources: Object.entries(retention).map(([module, retentionDays]) => ({
      module,
      retentionDays,
      actions: [],
    })),
  };
}

describe('action labels', () => {
  it.each([...IDENTITY_ACTIONS, ...DEVICES_ACTIONS, ...TV_ACTIONS])(
    'has a plain-language name for %s, and it is not the code',
    (code) => {
      const label = knownActionLabel(code);
      expect(label).not.toBeNull();
      expect(label).not.toMatch(/[_.]/);
      expect(label).not.toBe(code);
    },
  );

  it('gives every action a different name, so two rows are never confused', () => {
    const labels = [...IDENTITY_ACTIONS, ...DEVICES_ACTIONS, ...TV_ACTIONS].map((c) =>
      knownActionLabel(c),
    );
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('never shows a code it does not know: a new action reads as a generic one', () => {
    expect(knownActionLabel('algo_novo')).toBeNull();
    expect(auditActionLabel('algo_novo')).toBe('Outra ação');
  });
});

describe('module and outcome', () => {
  it('names each source in words, with a generic name for a new one', () => {
    expect(moduleLabel('identity')).toBe('Conta e acesso');
    expect(moduleLabel('devices')).toBe('Dispositivos');
    expect(moduleLabel('tv')).toBe('TV');
    expect(moduleLabel('novo')).toBe('Outro módulo');
  });

  it('shows the outcome with a word AND a shape, never the colour alone', () => {
    expect(outcomeView('success')).toMatchObject({ label: 'Sucesso', glyph: 'check', tone: 'ok' });
    expect(outcomeView('denied')).toMatchObject({ label: 'Recusado', glyph: 'ban', tone: 'warn' });
    expect(outcomeView('failure')).toMatchObject({ label: 'Erro', glyph: 'alert', tone: 'bad' });
    const unknown = outcomeView('talvez');
    expect(unknown.label).toBe('Sem resultado');
    expect(unknown.glyph).toBe('info');
    const glyphs = ['success', 'denied', 'failure'].map((o) => outcomeView(o).glyph);
    expect(new Set(glyphs).size).toBe(3);
  });

  it('offers the outcomes the API lists, in its order, and the three by default', () => {
    expect(outcomeChoices({ outcomes: ['denied', 'success', 'estranho'], sources: [] })).toEqual([
      'denied',
      'success',
    ]);
    expect(outcomeChoices(null)).toEqual(['success', 'denied', 'failure']);
  });

  it('names the periods', () => {
    expect(periodLabel('any')).toBe('Todo o período');
    expect(periodLabel('24h')).toBe('Últimas 24 horas');
    expect(periodLabel('7d')).toBe('Últimos 7 dias');
    expect(periodLabel('30d')).toBe('Últimos 30 dias');
  });
});

describe('actorLabel', () => {
  it('shows the current name of the account, never an e-mail', () => {
    expect(actorLabel(item())).toBe('Dono da Casa');
  });

  it('says "Conta apagada" when the account has no name any more', () => {
    expect(actorLabel(item({ actor: { id: 'u9', displayName: null } }))).toBe('Conta apagada');
  });

  it('says "Sem conta" when nobody was signed in', () => {
    expect(actorLabel(item({ actor: null }))).toBe('Sem conta');
  });
});

describe('describeTarget', () => {
  it('names the account the action was about, or says it was deleted', () => {
    expect(
      describeTarget(
        item({ action: 'permissions_changed', targetAccount: { id: 'g1', displayName: 'Bruno' } }),
      ),
    ).toBe('Bruno');
    expect(
      describeTarget(
        item({ action: 'guest_revoked', targetAccount: { id: 'g2', displayName: null } }),
      ),
    ).toBe('Conta apagada');
  });

  it('puts the TV targets in words: the key, the number of characters (never the text), the shortcuts, the app', () => {
    expect(describeTarget(item({ action: 'tv.key', target: 'VOLUME_UP/SHORT' }))).toBe(
      'Tecla volume up',
    );
    expect(describeTarget(item({ action: 'tv.text', target: 'length=6' }))).toBe('6 caracteres');
    expect(describeTarget(item({ action: 'tv.text', target: 'length=1' }))).toBe('1 caractere');
    expect(describeTarget(item({ action: 'tv.shortcuts.reorder', target: 'count=12' }))).toBe(
      '12 atalhos',
    );
    expect(describeTarget(item({ action: 'tv.shortcuts.reorder', target: 'count=1' }))).toBe(
      '1 atalho',
    );
    expect(describeTarget(item({ action: 'tv.app.launch', target: 'com.exemplo.app' }))).toBe(
      'App com.exemplo.app',
    );
    expect(describeTarget(item({ action: 'tv.config.bind', target: 'pc-casa' }))).toBe(
      'Computador pc-casa',
    );
    expect(
      describeTarget(item({ action: 'tv.cleanup.setting', target: 'background-app-closing=on' })),
    ).toBe('Ligado');
  });

  it('says what was confirmed with the passkey, in words', () => {
    expect(
      describeTarget(item({ action: 'step_up_succeeded', target: 'identity.permissions-change' })),
    ).toBe('Mudar as permissões de uma pessoa');
  });

  it('shows the name of the device in the pairing trail', () => {
    expect(
      describeTarget(item({ module: 'devices', action: 'pairing_approved', target: 'PC de casa' })),
    ).toBe('PC de casa');
  });

  it('hides what is only an opaque id (invite, passkey, pairing) and any shape it does not know', () => {
    const id = '0123456789abcdef0123456789abcdef';
    expect(describeTarget(item({ action: 'guest_invite_revoked', target: id }))).toBeNull();
    expect(describeTarget(item({ action: 'passkey_removed', target: id }))).toBeNull();
    expect(describeTarget(item({ action: 'tv.text', target: 'conteudo-estranho' }))).toBeNull();
    expect(describeTarget(item({ action: 'tv.wake', target: null }))).toBeNull();
  });
});

describe('describeChange', () => {
  it('says what a person gained and lost, in the words of the permissions', () => {
    expect(
      describeChange(
        item({ action: 'permissions_changed', detail: '+module:training,tv:control|-tv:power' }),
      ),
    ).toBe('Passou a poder: Controlar a TV, Usar o Treino. Deixou de poder: Desligar a TV');
  });

  it('says only the side that happened', () => {
    expect(describeChange(item({ action: 'permissions_changed', detail: '+tv:launch|-' }))).toBe(
      'Passou a poder: Abrir apps',
    );
    expect(describeChange(item({ action: 'permissions_changed', detail: '+|-tv:history' }))).toBe(
      'Deixou de poder: Ver o histórico',
    );
  });

  it('says what an invite grants, and how many rows an export carried', () => {
    expect(
      describeChange(
        item({ action: 'guest_invite_created', detail: 'module:training,module:tv,tv:control' }),
      ),
    ).toBe('Acesso do convite: Controlar a TV, Usar o Treino');
    expect(describeChange(item({ action: 'audit_exported', detail: 'rows=120' }))).toBe(
      '120 linhas no arquivo',
    );
    expect(describeChange(item({ action: 'audit_exported', detail: 'rows=1' }))).toBe(
      '1 linha no arquivo',
    );
  });

  it('never prints a raw detail: an error code or a shape it does not know says nothing', () => {
    expect(describeChange(item({ action: 'tv.key', detail: 'agent_offline' }))).toBeNull();
    expect(describeChange(item({ action: 'permissions_changed', detail: 'estranho' }))).toBeNull();
    expect(describeChange(item({ action: 'permissions_changed', detail: null }))).toBeNull();
  });
});

describe('summarizeUserAgent', () => {
  it.each([
    [
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
      'Safari no iPhone',
    ],
    [
      'Mozilla/5.0 (Linux; Android 14; SM-S711B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
      'Chrome no Android',
    ],
    [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0',
      'Edge no Windows',
    ],
    [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      'Chrome no Windows',
    ],
    ['Mozilla/5.0 (X11; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0', 'Firefox no Linux'],
    [
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
      'Safari no Mac',
    ],
    [
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0.0.0 Mobile/15E148 Safari/604.1',
      'Chrome no iPhone',
    ],
  ])('reads %#', (ua, expected) => {
    expect(summarizeUserAgent(ua)).toBe(expected);
  });

  it('says nothing when nothing was recorded', () => {
    expect(summarizeUserAgent(null)).toBeNull();
    expect(summarizeUserAgent('   ')).toBeNull();
  });

  it('keeps the name of a program that is not a browser (the computer agent), and never the whole string', () => {
    expect(summarizeUserAgent('AgenteUniOver/1.2.3 (windows)')).toBe('AgenteUniOver');
    expect(summarizeUserAgent('Mozilla/5.0')).toBe('Aparelho não identificado');
    expect(summarizeUserAgent('???')).toBe('Aparelho não identificado');
  });
});

describe('retentionText', () => {
  it('says one number when every trail keeps the same time', () => {
    expect(retentionText(sources({ identity: 180, devices: 180, tv: 180 }), [])).toBe(
      'Guardamos por 180 dias',
    );
  });

  it('says the longest time and puts the shorter trail in parentheses when they differ', () => {
    expect(retentionText(sources({ identity: 180, devices: 180, tv: 30 }), [])).toBe(
      'Guardamos por 180 dias (TV: 30 dias)',
    );
    expect(retentionText(sources({ identity: 180, devices: 90, tv: 30 }), [])).toBe(
      'Guardamos por 180 dias (Dispositivos: 90 dias; TV: 30 dias)',
    );
  });

  it('counts only the trails in view when modules are filtered', () => {
    const all = sources({ identity: 180, devices: 180, tv: 30 });
    expect(retentionText(all, ['tv'])).toBe('Guardamos por 30 dias');
    expect(retentionText(all, ['identity', 'devices'])).toBe('Guardamos por 180 dias');
  });

  it('reads the days even when the API sends them as text, and says "1 dia"', () => {
    expect(retentionText(sources({ identity: '90' }), [])).toBe('Guardamos por 90 dias');
    expect(retentionText(sources({ identity: 1 }), [])).toBe('Guardamos por 1 dia');
  });

  it('says nothing when there is no usable number or no source', () => {
    expect(retentionText(null, [])).toBeNull();
    expect(retentionText(sources({}), [])).toBeNull();
    expect(retentionText(sources({ identity: 0 }), [])).toBeNull();
    expect(retentionText(sources({ identity: 180 }), ['tv'])).toBeNull();
  });
});

describe('dates', () => {
  // Montadas na hora local: o resultado não depende do fuso de quem roda o teste.
  const at = new Date(2026, 9, 21, 14, 32).toISOString();

  it('shows day, month and the time of the browser, and the year only when it is not this year', () => {
    const sameYear = formatWhen(at, new Date(2026, 11, 1));
    expect(sameYear).toContain('21/10');
    expect(sameYear).toContain('14:32');
    expect(sameYear).not.toContain('2026');

    const otherYear = formatWhen(at, new Date(2027, 0, 5));
    expect(otherYear).toContain('21/10/2026');
  });

  it('shows the long form with the seconds in the details', () => {
    const full = formatWhenFull(at);
    expect(full).toContain('2026');
    expect(full).toContain('14:32:00');
  });

  it('shows nothing for a date it cannot read', () => {
    expect(formatWhen('não é data')).toBe('');
    expect(formatWhenFull('não é data')).toBe('');
  });
});
