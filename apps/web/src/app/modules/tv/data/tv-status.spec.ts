import { TvStatus } from './tv-store';
import { statusLabel, statusTone } from './tv-status';

const ALL: TvStatus[] = [
  'hot',
  'hibernating',
  'agent-off',
  'unconfigured',
  'offline',
  'waking',
  'loading',
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

describe('statusTone', () => {
  it('colors the dot by how healthy the link is', () => {
    expect(statusTone('hot')).toBe('ok');
    expect(statusTone('hibernating')).toBe('warn');
    expect(statusTone('agent-off')).toBe('bad');
    expect(statusTone('offline')).toBe('bad');
    expect(statusTone('loading')).toBe('idle');
  });
});
