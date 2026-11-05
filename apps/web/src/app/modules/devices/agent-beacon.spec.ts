import { AgentBeacon, agoText, codeReason, readAgentBeacons, startupLine } from './agent-beacon';

const AGENT = 'a1';
const SEEN = '2026-11-01T12:00:00Z';
const LATER = '2026-11-02T08:00:00Z';
const EARLIER = '2026-10-30T08:00:00Z';

function beacon(overrides: Partial<AgentBeacon> = {}): AgentBeacon {
  return {
    agentId: AGENT,
    stage: null,
    code: null,
    at: null,
    rejectReason: null,
    rejectedAt: null,
    ...overrides,
  };
}

describe('startupLine', () => {
  it('says nothing for a connected computer, even with old beacons', () => {
    expect(
      startupLine(true, SEEN, beacon({ stage: 'supervisor', code: 'crash_loop', at: LATER })),
    ).toBeNull();
  });

  it('says nothing without a beacon or when the beacon holds nothing', () => {
    expect(startupLine(false, SEEN, undefined)).toBeNull();
    expect(startupLine(false, SEEN, beacon())).toBeNull();
  });

  it('explains a failed start in plain words', () => {
    const line = startupLine(
      false,
      SEEN,
      beacon({ stage: 'child_spawn', code: 'blocked_sac', at: LATER }),
    );
    expect(line).toEqual({
      text: 'Não conseguiu iniciar: o Windows bloqueou o programa',
      failed: true,
      at: LATER,
    });
  });

  it('keeps the plain failure line for a code the screen does not know yet', () => {
    const line = startupLine(
      false,
      SEEN,
      beacon({ stage: 'selftest', code: 'brand_new', at: LATER }),
    );
    expect(line?.text).toBe('Não conseguiu iniciar');
    expect(line?.failed).toBe(true);
  });

  it('maps every known failure code', () => {
    for (const code of [
      'no_config',
      'vault_unreadable',
      'net_unreachable',
      'crash_loop',
      'blocked_sac',
      'blocked_av',
      'startup_disabled',
      'disk_full',
    ]) {
      expect(codeReason(code), code).toBeTruthy();
    }
    expect(codeReason('ok')).toBeNull();
  });

  it('shows the last stage reached when the start itself went fine', () => {
    const line = startupLine(false, SEEN, beacon({ stage: 'supervisor', code: 'ok', at: LATER }));
    expect(line).toEqual({ text: 'Última etapa: supervisor', failed: false, at: LATER });
    expect(
      startupLine(false, SEEN, beacon({ stage: 'stopped_by_user', code: 'ok', at: LATER }))?.text,
    ).toBe('Parado pelo usuário');
    expect(
      startupLine(false, SEEN, beacon({ stage: 'novo_passo', code: 'ok', at: LATER }))?.text,
    ).toBe('Mandou sinal ao iniciar');
  });

  it('ignores what happened before the last real contact', () => {
    expect(
      startupLine(false, SEEN, beacon({ stage: 'supervisor', code: 'crash_loop', at: EARLIER })),
    ).toBeNull();
    expect(
      startupLine(false, SEEN, beacon({ rejectReason: 'invalid_token', rejectedAt: EARLIER })),
    ).toBeNull();
  });

  it('uses every beacon when the computer never made contact', () => {
    const line = startupLine(
      false,
      null,
      beacon({ stage: 'bootstrap', code: 'no_config', at: EARLIER }),
    );
    expect(line?.text).toBe('Não conseguiu iniciar: falta a configuração');
  });

  it('shows "Credencial recusada" for a refused credential', () => {
    for (const reason of ['invalid_token', 'wrong_agent']) {
      const line = startupLine(false, SEEN, beacon({ rejectReason: reason, rejectedAt: LATER }));
      expect(line).toEqual({ text: 'Credencial recusada', failed: true, at: LATER });
    }
    expect(
      startupLine(false, SEEN, beacon({ rejectReason: 'protocol', rejectedAt: LATER }))?.text,
    ).toBe('Versão do agente recusada');
  });

  it('lets the newest of the beacon and the rejection win', () => {
    const rejectedLast = beacon({
      stage: 'supervisor',
      code: 'crash_loop',
      at: '2026-11-02T08:00:00Z',
      rejectReason: 'invalid_token',
      rejectedAt: '2026-11-02T09:00:00Z',
    });
    expect(startupLine(false, SEEN, rejectedLast)?.text).toBe('Credencial recusada');

    const signalledLast = { ...rejectedLast, at: '2026-11-02T10:00:00Z' };
    expect(startupLine(false, SEEN, signalledLast)?.text).toBe(
      'Não conseguiu iniciar: o agente fecha ao abrir',
    );
  });
});

describe('agoText', () => {
  const now = Date.parse('2026-11-05T12:00:00Z');

  it('writes the short time', () => {
    expect(agoText('2026-11-05T11:59:40Z', now)).toBe('agora');
    expect(agoText('2026-11-05T11:55:00Z', now)).toBe('há 5 min');
    expect(agoText('2026-11-05T09:00:00Z', now)).toBe('há 3 h');
    expect(agoText('2026-11-04T09:00:00Z', now)).toBe('há 1 dia');
    expect(agoText('2026-11-02T09:00:00Z', now)).toBe('há 3 dias');
  });
});

describe('readAgentBeacons', () => {
  it('keeps what the API sent and turns missing fields into null', () => {
    const items = readAgentBeacons({
      items: [
        {
          agentId: AGENT,
          stage: 'bootstrap',
          code: 'ok',
          at: LATER,
          count: 2,
          verified: false,
        } as never,
      ],
    });
    expect(items).toEqual([beacon({ stage: 'bootstrap', code: 'ok', at: LATER })]);
  });

  it('survives an unexpected shape', () => {
    expect(readAgentBeacons(null)).toEqual([]);
    expect(readAgentBeacons({} as never)).toEqual([]);
  });
});
