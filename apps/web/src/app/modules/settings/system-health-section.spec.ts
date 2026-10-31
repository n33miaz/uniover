import { TestBed } from '@angular/core/testing';
import { SessionState } from '../../core/session/session-state';
import { SystemApi } from './system-api';
import { SystemHealthSection } from './system-health-section';

describe('SystemHealthSection', () => {
  const system = {
    agents: vi.fn(),
    tvs: vi.fn(),
    deploymentVersion: vi.fn(),
    deadLetters: vi.fn(),
  };

  beforeEach(() => {
    localStorage.clear();
    system.agents.mockReset().mockResolvedValue([
      {
        id: 'agent-1',
        slug: 'sala',
        name: 'PC da sala',
        platform: 'windows',
        createdAt: '2026-10-27T10:00:00Z',
        revoked: false,
        lastSeenAt: '2026-10-27T10:10:00Z',
        connected: true,
      },
    ]);
    system.tvs.mockReset().mockResolvedValue([
      {
        id: 'tv-1',
        name: 'TV da sala',
        isDefault: true,
        agentSlug: 'sala',
        kind: 'android',
        online: true,
        capabilities: [],
      },
    ]);
    system.deploymentVersion.mockReset().mockResolvedValue({ commit: 'abc1234' });
    system.deadLetters
      .mockReset()
      .mockResolvedValue({ total: 0, items: [], unavailableModules: [] });
    TestBed.configureTestingModule({
      providers: [{ provide: SystemApi, useValue: system }],
    });
  });

  afterEach(() => localStorage.clear());

  it('shows agent, television, API, version and failed events as five readings', async () => {
    const session = TestBed.inject(SessionState);
    session.setToken('t', 600);
    session.setUser({ id: '1', email: 'a@b.c', displayName: 'Dono', role: 'owner' });
    const fixture = TestBed.createComponent(SystemHealthSection);
    await fixture.whenStable();
    fixture.detectChanges();
    const metrics = Array.from<HTMLElement>(
      (fixture.nativeElement as HTMLElement).querySelectorAll('.metric'),
    );
    expect(metrics).toHaveLength(5);
    expect(metrics[0].textContent).toContain('Agente');
    expect(metrics[0].textContent).toContain('Ligado');
    expect(metrics[0].textContent).toContain('PC da sala');
    expect(metrics[1].textContent).toContain('TV');
    expect(metrics[1].textContent).toContain('On-line');
    expect(metrics[1].textContent).toContain('TV da sala');
    expect(metrics[2].textContent).toContain('API');
    expect(metrics[2].textContent).toContain('OK');
    expect(metrics[3].textContent).toContain('abc1234');
    expect(metrics[4].textContent).toContain('Eventos');
    expect(metrics[4].textContent).toContain('Nenhum');
  });

  it('shortens a full commit identifier to seven characters in the version reading', async () => {
    system.deploymentVersion.mockResolvedValue({
      commit: 'abcdef0123456789abcdef0123456789abcdef01',
    });
    const session = TestBed.inject(SessionState);
    session.setToken('t', 600);
    session.setUser({ id: '1', email: 'a@b.c', displayName: 'Dono', role: 'owner' });
    const fixture = TestBed.createComponent(SystemHealthSection);
    await fixture.whenStable();
    fixture.detectChanges();
    const version = (fixture.nativeElement as HTMLElement).querySelectorAll('.metric')[3];
    expect(version.querySelector('strong')?.textContent?.trim()).toBe('abcdef0');
  });

  it('lists the events that exhausted their attempts, without the payload', async () => {
    system.deadLetters.mockResolvedValue({
      total: 3,
      items: [
        {
          module: 'tv',
          id: 'e-1',
          type: 'tv.state-changed.v1',
          failedAt: '2026-10-31T12:00:00Z',
          attempts: 8,
          lastError: 'InvalidOperationException',
        },
      ],
      unavailableModules: [],
    });
    const session = TestBed.inject(SessionState);
    session.setToken('t', 600);
    session.setUser({ id: '1', email: 'a@b.c', displayName: 'Dono', role: 'owner' });
    const fixture = TestBed.createComponent(SystemHealthSection);
    await fixture.whenStable();
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;
    const reading = root.querySelectorAll('.metric')[4];
    expect(reading.textContent).toContain('3 falhos');
    expect(reading.querySelector('strong')?.classList.contains('bad')).toBe(true);
    const list = root.querySelector('.dead');
    expect(list?.textContent).toContain('tv.state-changed.v1');
    expect(list?.textContent).toContain('InvalidOperationException');
  });

  it('keeps the rest of the health card when the failed events cannot be read', async () => {
    system.deadLetters.mockRejectedValue(new Error('boom'));
    const session = TestBed.inject(SessionState);
    session.setToken('t', 600);
    session.setUser({ id: '1', email: 'a@b.c', displayName: 'Dono', role: 'owner' });
    const fixture = TestBed.createComponent(SystemHealthSection);
    await fixture.whenStable();
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;
    expect(root.querySelector('[role="alert"]')).toBeNull();
    const metrics = root.querySelectorAll('.metric');
    expect(metrics).toHaveLength(5);
    expect(metrics[0].textContent).toContain('Ligado');
    expect(metrics[4].textContent).toContain('Leitura indisponível');
  });

  it('does not request health data for a guest', async () => {
    const session = TestBed.inject(SessionState);
    session.setToken('t', 600);
    session.setUser({ id: '1', email: 'a@b.c', displayName: 'Convidado', role: 'guest' });
    const fixture = TestBed.createComponent(SystemHealthSection);
    await fixture.whenStable();
    fixture.detectChanges();
    expect(system.agents).not.toHaveBeenCalled();
    expect(system.tvs).not.toHaveBeenCalled();
  });

  it('holds four tiles as a busy skeleton until the readings arrive', async () => {
    let finish: (agents: unknown[]) => void = () => undefined;
    system.agents.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    const session = TestBed.inject(SessionState);
    session.setToken('t', 600);
    session.setUser({ id: '1', email: 'a@b.c', displayName: 'Dono', role: 'owner' });
    const fixture = TestBed.createComponent(SystemHealthSection);
    const el = fixture.nativeElement as HTMLElement;
    await fixture.whenStable();
    fixture.detectChanges();

    expect(
      el.querySelector('app-loading-skeleton app-loading-frame[aria-busy="true"]'),
    ).not.toBeNull();
    expect(el.querySelectorAll('app-loading-skeleton .tile')).toHaveLength(4);
    expect(el.querySelector('.metric')).toBeNull();

    finish([]);
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(el.querySelector('app-loading-skeleton')).toBeNull();
    });
    expect(el.querySelectorAll('.metric')).toHaveLength(4);
  });
});
