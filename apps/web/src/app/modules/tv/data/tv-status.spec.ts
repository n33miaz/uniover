import { TvStatus } from './tv-store';
import {
  TvIndicator,
  TvPhase,
  WATCHDOG_REPAIR_FAILED,
  deriveIndicator,
  indicatorPhase,
  indicatorText,
  statusLabel,
} from './tv-status';

const ALL: TvStatus[] = [
  'hot',
  'hibernating',
  'agent-off',
  'unconfigured',
  'offline',
  'loading',
  'unresponsive',
  'pc-off',
];

const INDICATORS: TvIndicator[] = [
  'connected',
  'sleeping',
  'connecting',
  'unresponsive',
  'agent-off',
  'pc-off',
  'not-configured',
  'offline',
  'repair-failed',
];

describe('statusLabel', () => {
  it('says "controle dormindo" when hibernating, never "TV desligada"', () => {
    expect(statusLabel('hibernating')).toBe('controle dormindo');
    expect(statusLabel('hibernating')).not.toMatch(/desligada/i);
  });

  it('says "agente desligado" when the agent is down (it is not the TV)', () => {
    expect(statusLabel('agent-off')).toBe('agente desligado');
  });

  it('names the other states', () => {
    expect(statusLabel('hot')).toBe('conectada');
    expect(statusLabel('offline')).toBe('sem rede');
    expect(statusLabel('unconfigured')).toBe('sem agente configurado');
    expect(statusLabel('loading')).toBe('reconectando…');
    expect(statusLabel('pc-off')).toBe('PC desligado');
    expect(statusLabel('unresponsive')).toBe('sem resposta');
  });

  it('no label says the TV is switched off', () => {
    for (const status of ALL) expect(statusLabel(status)).not.toMatch(/tv desligada/i);
  });
});

describe('deriveIndicator', () => {
  it.each<[TvStatus, TvIndicator]>([
    ['hot', 'connected'],
    ['hibernating', 'sleeping'],
    ['loading', 'connecting'],
    ['unresponsive', 'unresponsive'],
    ['pc-off', 'pc-off'],
    ['agent-off', 'agent-off'],
    ['unconfigured', 'not-configured'],
    ['offline', 'offline'],
  ])('%s becomes %s when the watchdog has nothing to say', (status, expected) => {
    expect(deriveIndicator(status, null)).toBe(expected);
  });

  it('a failed repair is "attention" while the remote looks up (connected or asleep)', () => {
    expect(deriveIndicator('hot', WATCHDOG_REPAIR_FAILED)).toBe('repair-failed');
    expect(deriveIndicator('hibernating', WATCHDOG_REPAIR_FAILED)).toBe('repair-failed');
  });

  it('a failed repair does not hide the bigger problems (no network, no agent, PC off, not sure yet)', () => {
    expect(deriveIndicator('offline', WATCHDOG_REPAIR_FAILED)).toBe('offline');
    expect(deriveIndicator('agent-off', WATCHDOG_REPAIR_FAILED)).toBe('agent-off');
    expect(deriveIndicator('pc-off', WATCHDOG_REPAIR_FAILED)).toBe('pc-off');
    expect(deriveIndicator('loading', WATCHDOG_REPAIR_FAILED)).toBe('connecting');
  });

  it('other watchdog news (repaired, recovered) do not raise attention', () => {
    expect(deriveIndicator('hot', 'repaired')).toBe('connected');
    expect(deriveIndicator('hot', 'recovered')).toBe('connected');
  });
});

describe('indicatorPhase', () => {
  it('gives each visual phase to the states, one distinct shape per phase', () => {
    const phases = Object.fromEntries(
      INDICATORS.map((indicator) => [indicator, indicatorPhase(indicator)]),
    ) as Record<TvIndicator, TvPhase>;
    expect(phases).toEqual({
      connected: 'connected',
      sleeping: 'sleeping',
      connecting: 'connecting',
      unresponsive: 'no-reply',
      'agent-off': 'agent-off',
      'pc-off': 'pc-off',
      'not-configured': 'attention',
      offline: 'offline',
      'repair-failed': 'attention',
    });
    expect(new Set(Object.values(phases)).size).toBe(8);
  });
});

describe('indicatorText', () => {
  it('names every state in plain language, with a sentence and no empty text', () => {
    for (const indicator of INDICATORS) {
      const text = indicatorText(indicator, 5);
      expect(text.title.length, indicator).toBeGreaterThan(2);
      expect(text.meaning.length, indicator).toBeGreaterThan(20);
    }
  });

  it('offers to wake the remote when it sleeps and says the TV itself is untouched', () => {
    const text = indicatorText('sleeping', 5);
    expect(text.title).toBe('Dormindo');
    expect(text.action).toBe('wake');
    expect(text.actionLabel).toBe('Acordar o controle');
    expect(text.meaning).not.toMatch(/tv desligada/i);
  });

  it('offers "Tentar de Novo" when the agent or the PC is off, nothing answered, or it is not configured', () => {
    for (const indicator of [
      'agent-off',
      'pc-off',
      'unresponsive',
      'not-configured',
      'repair-failed',
    ] as const) {
      const text = indicatorText(indicator, 5);
      expect(text.action, indicator).toBe('retry');
      expect(text.actionLabel, indicator).toBe('Tentar de Novo');
    }
  });

  it('has no action when nothing can be done from here (connected, still connecting, no network)', () => {
    for (const indicator of ['connected', 'connecting', 'offline'] as const) {
      expect(indicatorText(indicator, 5).action, indicator).toBeNull();
    }
  });

  it('says "Reconectando…" while it is not sure yet, and that the buttons already work', () => {
    const text = indicatorText('connecting', 5);
    expect(text.title).toBe('Reconectando…');
    expect(text.meaning).toContain('Os botões já funcionam');
    expect(indicatorText('unresponsive', 5).title).toBe('Sem Resposta');
  });

  it('says how long until the connected remote goes to sleep, from the configuration', () => {
    expect(indicatorText('connected', 5).meaning).toContain('5 min');
    expect(indicatorText('connected', 9).meaning).toContain('9 min');
  });

  describe('for who cannot control the TV (only watches it)', () => {
    it('never tells to tap, to wake it up or to use buttons, which that person does not have', () => {
      for (const indicator of INDICATORS) {
        const text = indicatorText(indicator, 5, false);
        expect(text.meaning, indicator).not.toMatch(/toque|botões|botão|acord/i);
        expect(text.meaning.length, indicator).toBeGreaterThan(20);
      }
    });

    it('still says what the state is, and how long until the connected remote sleeps', () => {
      expect(indicatorText('sleeping', 5, false).title).toBe('Dormindo');
      expect(indicatorText('sleeping', 5, false).meaning).toBe(
        'Só o controle está dormindo para poupar a TV; ela continua como estava.',
      );
      expect(indicatorText('connected', 9, false).meaning).toBe(
        'O controle está falando com a TV. Depois de 9 min sem uso ele dorme sozinho.',
      );
    });

    it('keeps the full text for who controls (the default), tap included', () => {
      expect(indicatorText('sleeping', 5).meaning).toContain('O primeiro toque acorda.');
      expect(indicatorText('sleeping', 5, true).meaning).toContain('O primeiro toque acorda.');
      expect(indicatorText('connected', 5).meaning).toContain('acorda no primeiro toque');
      expect(indicatorText('connecting', 5).meaning).toContain('Os botões já funcionam');
    });
  });

  it('lists the three known problems of the TV remote service when the repair gives up', () => {
    const { hints } = indicatorText('repair-failed', 5);
    expect(hints.map((hint) => hint.title)).toEqual([
      'Serviço Desatualizado',
      'Serviços Parados',
      'Caixa de TV',
    ]);
    expect(hints[0].body).toContain('Android TV Remote Service');
    expect(hints[0].body).toContain('reinicie a TV');
    expect(hints[1].body).toContain('reinicie a TV');
    expect(hints[2].body).toContain('caixas');
    for (const hint of hints) expect(hint.body.length).toBeLessThan(110);
  });

  it('lists nothing for the other states', () => {
    for (const indicator of INDICATORS.filter((item) => item !== 'repair-failed')) {
      expect(indicatorText(indicator, 5).hints, indicator).toEqual([]);
    }
  });

  it('never says the TV is switched off', () => {
    for (const indicator of INDICATORS) {
      const text = indicatorText(indicator, 5);
      expect(`${text.title} ${text.meaning}`, indicator).not.toMatch(/tv desligada/i);
    }
  });
});

describe('indicatorText with a known offline instant', () => {
  it('names the PC and since when, in the title, only for the confirmed PC-off state', () => {
    const text = indicatorText('pc-off', 5, true, 'PC Desligado desde 28/10 19:24');
    expect(text.title).toBe('PC Desligado desde 28/10 19:24');
    expect(indicatorText('pc-off', 5).title).toBe('PC Desligado');
    // O agente fora sem o "desde quando" segue como era antes.
    expect(indicatorText('agent-off', 5, true, 'PC Desligado desde 28/10 19:24').title).toBe(
      'Agente desligado',
    );
  });
});
