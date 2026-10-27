import { TestBed } from '@angular/core/testing';
import { DevicesApi } from '../devices/devices-api';
import { SessionState } from '../../core/session/session-state';
import { SystemApi } from './system-api';
import { SystemHealthSection } from './system-health-section';

describe('SystemHealthSection', () => {
  const devices = { list: vi.fn() };
  const system = { tvs: vi.fn(), deploymentVersion: vi.fn() };

  beforeEach(() => {
    localStorage.clear();
    devices.list.mockReset().mockResolvedValue([
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
      providers: [
        { provide: DevicesApi, useValue: devices },
        { provide: SystemApi, useValue: system },
      ],
    });
  });

  afterEach(() => localStorage.clear());

  it('shows the existing agent, television and deployment readings together', async () => {
    const session = TestBed.inject(SessionState);
    session.setToken('t', 600);
    session.setUser({ id: '1', email: 'a@b.c', displayName: 'Dono', role: 'owner' });
    const fixture = TestBed.createComponent(SystemHealthSection);
    await fixture.whenStable();
    fixture.detectChanges();
    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('PC da sala');
    expect(text).toContain('Agente on-line');
    expect(text).toContain('TV da sala: on-line');
    expect(text).toContain('API abc1234');
  });

  it('does not request health data for a guest', async () => {
    const session = TestBed.inject(SessionState);
    session.setToken('t', 600);
    session.setUser({ id: '1', email: 'a@b.c', displayName: 'Convidado', role: 'guest' });
    const fixture = TestBed.createComponent(SystemHealthSection);
    await fixture.whenStable();
    fixture.detectChanges();
    expect(devices.list).not.toHaveBeenCalled();
    expect(system.tvs).not.toHaveBeenCalled();
  });
});
