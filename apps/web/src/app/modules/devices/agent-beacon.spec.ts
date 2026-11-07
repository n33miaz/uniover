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
      verified: false,
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

  it('gives each new agent code a plain reason', () => {
    expect(codeReason('no_app')).toBe('faltam os arquivos do agente');
    expect(codeReason('no_uv', 'supervisor')).toBe('faltou o uv no PC');
    expect(codeReason('sync_failed', 'supervisor')).toBe('falhou ao preparar o ambiente');
    expect(codeReason('disk_full', 'supervisor')).toBe('o disco está cheio');
    expect(codeReason('stale', 'supervisor')).toBe('o supervisor travou e foi reiniciado');
    expect(codeReason('crash_loop', 'child_exit')).toBe('o agente caiu várias vezes seguidas');
    expect(codeReason('crash_loop')).toBe('o agente fecha ao abrir');
    expect(codeReason('unresponsive', 'child_exit')).toBe('o agente parou de responder');
  });

  it('reads the exit code out of exit_N, by who exited', () => {
    expect(codeReason('exit_3', 'child_exit')).toBe('o agente fechou (código 3)');
    expect(codeReason('exit_1', 'supervisor')).toBe('o supervisor fechou (código 1)');
    expect(codeReason('exit_-1', 'child_exit')).toBe('o agente fechou (código -1)');
    expect(codeReason('exit_')).toBeNull();
    expect(codeReason('exit_abc')).toBeNull();
    expect(codeReason('exit_1x')).toBeNull();
  });

  it('keeps the unverified clue line for the new codes, and an unknown one stays generic', () => {
    const line = startupLine(
      false,
      SEEN,
      beacon({ stage: 'child_exit', code: 'exit_7', at: LATER }),
    );
    expect(line).toEqual({
      text: 'Não conseguiu iniciar: o agente fechou (código 7)',
      failed: true,
      at: LATER,
      verified: false,
    });
    expect(
      startupLine(false, SEEN, beacon({ stage: 'supervisor', code: 'no_uv', at: LATER }))?.text,
    ).toBe('Não conseguiu iniciar: faltou o uv no PC');
    expect(
      startupLine(false, SEEN, beacon({ stage: 'child_exit', code: 'exit_', at: LATER }))?.text,
    ).toBe('Não conseguiu iniciar');
  });

  it('does not treat child_spawn ok or bootstrap ok as a failure', () => {
    for (const stage of ['child_spawn', 'bootstrap']) {
      const line = startupLine(false, SEEN, beacon({ stage, code: 'ok', at: LATER }));
      expect(line?.failed, stage).toBe(false);
    }
  });

  it('shows the last stage reached when the start itself went fine', () => {
    const line = startupLine(false, SEEN, beacon({ stage: 'supervisor', code: 'ok', at: LATER }));
    expect(line).toEqual({
      text: 'Última etapa: supervisor',
      failed: false,
      at: LATER,
      verified: false,
    });
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
      expect(line).toEqual({
        text: 'Credencial recusada',
        failed: true,
        at: LATER,
        verified: false,
      });
    }
    expect(
      startupLine(false, SEEN, beacon({ rejectReason: 'protocol', rejectedAt: LATER }))?.text,
    ).toBe('Versão do agente recusada');
  });

  it('lets only a refusal that needs a real token win over a newer anonymous beacon', () => {
    const wrongAgent = beacon({
      stage: 'hello_sent',
      code: 'ok',
      at: '2026-11-02T10:00:00Z',
      rejectReason: 'wrong_agent',
      rejectedAt: '2026-11-02T09:00:00Z',
    });
    expect(startupLine(false, SEEN, wrongAgent)?.text).toBe('Credencial recusada');
  });

  it('makes a forgeable invalid_token compete with the beacon by time', () => {
    const base = beacon({
      stage: 'child_spawn',
      code: 'blocked_av',
      rejectReason: 'invalid_token',
    });
    // O token inventado é mais novo: ele vence. A baliza é mais nova: ela vence (o ataque não esconde a pista verdadeira).
    expect(
      startupLine(false, SEEN, {
        ...base,
        at: '2026-11-02T08:00:00Z',
        rejectedAt: '2026-11-02T09:00:00Z',
      })?.text,
    ).toBe('Credencial recusada');
    expect(
      startupLine(false, SEEN, {
        ...base,
        at: '2026-11-02T10:00:00Z',
        rejectedAt: '2026-11-02T09:00:00Z',
      })?.text,
    ).toBe('Não conseguiu iniciar: o antivírus bloqueou');
  });

  it('shows the protocol refusal while connected, as "connected but refused"', () => {
    const line = startupLine(true, SEEN, beacon({ rejectReason: 'protocol', rejectedAt: LATER }));
    expect(line).toEqual({
      text: 'Conectado, mas a versão do agente foi recusada',
      failed: true,
      at: LATER,
      verified: true,
    });
  });

  it('keeps the protocol refusal after the session drops, although the drop is the newest contact', () => {
    // A linha do tempo real: o hello é recusado com a conexão aberta (09:00) e a queda grava o último contato depois (09:30).
    const refusedAt = '2026-11-02T09:00:00Z';
    const droppedAt = '2026-11-02T09:30:00Z';
    const clue = beacon({ rejectReason: 'protocol', rejectedAt: refusedAt });

    expect(startupLine(true, droppedAt, clue)?.text).toBe(
      'Conectado, mas a versão do agente foi recusada',
    );
    expect(startupLine(false, droppedAt, clue)).toEqual({
      text: 'Versão do agente recusada',
      failed: true,
      at: refusedAt,
      verified: true,
    });
  });

  it('does not let any other refusal show on a connected computer', () => {
    expect(
      startupLine(true, SEEN, beacon({ rejectReason: 'invalid_token', rejectedAt: LATER })),
    ).toBeNull();
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
