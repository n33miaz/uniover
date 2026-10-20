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
  'waking',
  'loading',
];

const INDICATORS: TvIndicator[] = [
  'connected',
  'sleeping',
  'connecting',
  'server-waking',
  'agent-off',
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
    expect(statusLabel('waking')).toBe('servidor acordando');
    expect(statusLabel('unconfigured')).toBe('sem agente configurado');
    expect(statusLabel('loading')).toBe('conectando…');
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
    ['waking', 'server-waking'],
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

  it('a failed repair does not hide the bigger problems (no network, no agent, server waking)', () => {
    expect(deriveIndicator('offline', WATCHDOG_REPAIR_FAILED)).toBe('offline');
    expect(deriveIndicator('agent-off', WATCHDOG_REPAIR_FAILED)).toBe('agent-off');
    expect(deriveIndicator('waking', WATCHDOG_REPAIR_FAILED)).toBe('server-waking');
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
      'server-waking': 'connecting',
      'agent-off': 'agent-off',
      'not-configured': 'attention',
      offline: 'offline',
      'repair-failed': 'attention',
    });
    expect(new Set(Object.values(phases)).size).toBe(6);
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

  it('offers "Tentar de novo" when the agent is missing, not configured or in trouble', () => {
    for (const indicator of [
      'agent-off',
      'not-configured',
      'repair-failed',
      'connecting',
    ] as const) {
      const text = indicatorText(indicator, 5);
      expect(text.action, indicator).toBe('retry');
      expect(text.actionLabel, indicator).toBe('Tentar de novo');
    }
  });

  it('has no action when nothing can be done from here (connected, server waking, no network)', () => {
    for (const indicator of ['connected', 'server-waking', 'offline'] as const) {
      expect(indicatorText(indicator, 5).action, indicator).toBeNull();
    }
  });

  it('says how long until the connected remote goes to sleep, from the configuration', () => {
    expect(indicatorText('connected', 5).meaning).toContain('5 min');
    expect(indicatorText('connected', 9).meaning).toContain('9 min');
  });

  it('never says the TV is switched off', () => {
    for (const indicator of INDICATORS) {
      const text = indicatorText(indicator, 5);
      expect(`${text.title} ${text.meaning}`, indicator).not.toMatch(/tv desligada/i);
    }
  });
});
