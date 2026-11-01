import { TestBed } from '@angular/core/testing';
import { SessionState } from '../../core/session/session-state';
import { CapacityReport, SystemApi } from './system-api';
import { SystemCapacitySection } from './system-capacity-section';

const MIB = 1024 * 1024;

function report(overrides: Partial<CapacityReport> = {}): CapacityReport {
  return {
    database: {
      bytes: 14.7 * MIB,
      limitBytes: 1024 * MIB,
      percent: 1.43,
      band: 'green',
      tables: [
        { schema: 'tv', name: 'command_audit', bytes: 2.6 * MIB },
        { schema: 'identity', name: 'login_audit', bytes: 336 * 1024 },
      ],
    },
    server: {
      workingSetBytes: 180 * MIB,
      heapBytes: 60 * MIB,
      memoryLimitBytes: 512 * MIB,
      memoryPercent: 35.2,
      memoryBand: 'green',
      startedAt: '2026-10-30T10:00:00Z',
      uptimeSeconds: 3 * 86400 + 4 * 3600,
      monthHours: 612,
      hoursLimit: 750,
      hoursPercent: 81.6,
      hoursBand: 'red',
    },
    growth: {
      points: [
        { day: '2026-10-29', bytes: 14 * MIB },
        { day: '2026-10-30', bytes: 14.4 * MIB },
        { day: '2026-10-31', bytes: 14.7 * MIB },
      ],
      bytesPerDay: 0.35 * MIB,
      daysToAmber: 1420,
      daysToRed: 2300,
      state: 'growing',
    },
    alerts: [],
    measuredAt: '2026-10-31T12:00:00Z',
    ...overrides,
  };
}

describe('SystemCapacitySection', () => {
  const system = { capacity: vi.fn(), dismissCapacityAlerts: vi.fn() };

  beforeEach(() => {
    localStorage.clear();
    system.capacity.mockReset().mockResolvedValue(report());
    system.dismissCapacityAlerts.mockReset().mockResolvedValue(undefined);
    TestBed.configureTestingModule({ providers: [{ provide: SystemApi, useValue: system }] });
  });

  afterEach(() => localStorage.clear());

  async function renderFixture(role: 'owner' | 'guest' = 'owner') {
    const session = TestBed.inject(SessionState);
    session.setToken('t', 600);
    session.setUser({ id: '1', email: 'a@b.c', displayName: 'Dono', role });
    const fixture = TestBed.createComponent(SystemCapacitySection);
    await fixture.whenStable();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    return fixture;
  }

  async function render(role: 'owner' | 'guest' = 'owner'): Promise<HTMLElement> {
    return (await renderFixture(role)).nativeElement as HTMLElement;
  }

  it('shows database, memory and month hours against their limits, with the band in words', async () => {
    const root = await render();
    const meters = Array.from(root.querySelectorAll<HTMLElement>('.meter'));
    expect(meters).toHaveLength(3);
    expect(meters[0].textContent).toContain('Banco');
    expect(meters[0].textContent).toContain('14,7 MB de 1 GB');
    expect(meters[0].textContent).toContain('1,4% · Folga');
    expect(meters[0].dataset['band']).toBe('green');
    expect(meters[1].textContent).toContain('180 MB de 512 MB');
    expect(meters[2].textContent).toContain('612 h de 750 h');
    expect(meters[2].textContent).toContain('82% · Crítico');
    expect(meters[2].dataset['band']).toBe('red');
  });

  it('labels the estimated readings and says plainly what the app does not measure', async () => {
    const root = await render();
    expect(root.querySelectorAll('.meter .tag')).toHaveLength(3);
    expect(root.querySelector('.meter .tag')?.textContent?.trim()).toBe('Estimado');
    expect(root.textContent).toContain('Dias corridos × 24');
    expect(root.textContent).toContain('Não medido');
    expect(root.textContent).toContain('3 d 4 h');
  });

  it('gives each bar an accessible name and a value capped at 100', async () => {
    system.capacity.mockResolvedValue(
      report({ database: { ...report().database, percent: 130, band: 'red' } }),
    );
    const root = await render();
    const bars = Array.from(root.querySelectorAll<HTMLElement>('[role="meter"]'));
    expect(bars.map((bar) => bar.getAttribute('aria-label'))).toEqual([
      'Banco',
      'Memória',
      'Horas do Mês',
    ]);
    expect(bars[0].getAttribute('aria-valuenow')).toBe('100');
  });

  it('lists the largest tables and projects when the database reaches 50% and 80%', async () => {
    const root = await render();
    const tables = root.querySelectorAll('.tables li');
    expect(tables).toHaveLength(2);
    expect(tables[0].textContent).toContain('tv.command_audit');
    expect(tables[0].textContent).toContain('2,6 MB');
    const growth = root.textContent ?? '';
    expect(growth).toContain('+358,4 KB por dia');
    expect(growth).toContain('Chega a 50%');
    expect(growth).toContain('Mais de 2 anos');
    expect(root.querySelector('svg.spark polyline')).not.toBeNull();
  });

  it('asks for a few more days when there is too little history for a trend', async () => {
    system.capacity.mockResolvedValue(
      report({
        growth: {
          points: [{ day: '2026-10-31', bytes: 14.7 * MIB }],
          bytesPerDay: null,
          daysToAmber: null,
          daysToRed: null,
          state: 'few',
        },
      }),
    );
    const root = await render();
    expect(root.querySelector('.few')?.textContent).toContain('Poucos dados');
    expect(root.querySelector('svg.spark')).toBeNull();
    expect(root.textContent).not.toContain('Chega a 50%');
  });

  it('says there is no growth, and when a limit is already behind, instead of inventing a date', async () => {
    system.capacity.mockResolvedValue(
      report({
        growth: {
          points: [
            { day: '2026-10-30', bytes: 700 * MIB },
            { day: '2026-10-31', bytes: 700 * MIB },
          ],
          bytesPerDay: 0,
          daysToAmber: 0,
          daysToRed: null,
          state: 'flat',
        },
      }),
    );
    const root = await render();
    expect(root.querySelector('.rate')?.textContent).toContain('Sem crescimento');
    const when = Array.from(root.querySelectorAll('.when dd')).map((dd) => dd.textContent?.trim());
    expect(when).toEqual(['Já passou', 'Sem data']);
  });

  it('shows an open alert and removes it on dismiss', async () => {
    system.capacity.mockResolvedValue(
      report({
        alerts: [
          { id: 'a1', metric: 'hours', percent: 81, detectedAt: '2026-10-31T09:00:00Z' },
          { id: 'a2', metric: 'database', percent: 90, detectedAt: '2026-10-31T09:00:00Z' },
        ],
      }),
    );
    const fixture = await renderFixture();
    const root = fixture.nativeElement as HTMLElement;
    const alert = root.querySelector('.alert');
    expect(alert?.textContent).toContain('Passou de 80%');
    expect(alert?.textContent).toContain('Horas do Mês, Banco');

    root.querySelector<HTMLButtonElement>('.alert button')?.click();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(system.dismissCapacityAlerts).toHaveBeenCalledTimes(1);
    expect(root.querySelector('.alert')).toBeNull();
  });

  it('shows an error when the reading fails, and no alert block', async () => {
    system.capacity.mockRejectedValue(new Error('boom'));
    const root = await render();
    expect(root.querySelector('[role="alert"]')?.textContent).toContain(
      'Não foi possível carregar a capacidade.',
    );
    expect(root.querySelector('.meter')).toBeNull();
  });

  it('does not request anything for a guest', async () => {
    await render('guest');
    expect(system.capacity).not.toHaveBeenCalled();
  });
});
