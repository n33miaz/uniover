import { TestBed } from '@angular/core/testing';
import { SessionState } from '../../core/session/session-state';
import { SystemApi } from './system-api';
import { SystemHealthSection } from './system-health-section';

describe('SystemHealthSection', () => {
  const system = { agents: vi.fn(), tvs: vi.fn(), deploymentVersion: vi.fn() };

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
    TestBed.configureTestingModule({
      providers: [{ provide: SystemApi, useValue: system }],
    });
  });

  afterEach(() => localStorage.clear());

  it('shows agent, television, API and version as four readings', async () => {
    const session = TestBed.inject(SessionState);
    session.setToken('t', 600);
    session.setUser({ id: '1', email: 'a@b.c', displayName: 'Dono', role: 'owner' });
    const fixture = TestBed.createComponent(SystemHealthSection);
    await fixture.whenStable();
    fixture.detectChanges();
    const metrics = Array.from<HTMLElement>(
      (fixture.nativeElement as HTMLElement).querySelectorAll('.metric'),
    );
    expect(metrics).toHaveLength(4);
    expect(metrics[0].textContent).toContain('Agente');
    expect(metrics[0].textContent).toContain('Ligado');
    expect(metrics[0].textContent).toContain('PC da sala');
    expect(metrics[1].textContent).toContain('TV');
    expect(metrics[1].textContent).toContain('On-line');
    expect(metrics[1].textContent).toContain('TV da sala');
    expect(metrics[2].textContent).toContain('API');
    expect(metrics[2].textContent).toContain('OK');
    expect(metrics[3].textContent).toContain('abc1234');
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
