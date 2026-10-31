import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { AuthApi } from '../../core/auth/auth-api';
import { AuthService } from '../../core/auth/auth.service';
import { DeviceAgent, DevicesApi } from './devices-api';
import { DevicesPage } from './devices.page';

const PC: DeviceAgent = {
  id: 'a1',
  slug: 'agent:pc-de-casa',
  name: 'PC de casa',
  platform: 'windows',
  createdAt: '2026-10-18T12:00:00Z',
  revoked: false,
  lastSeenAt: '2026-10-19T09:00:00Z',
  connected: true,
  canReadLogs: true,
  canMaintain: true,
  canRollback: false,
};

describe('DevicesPage while the list is requested', () => {
  const api = { list: vi.fn(), alerts: vi.fn(), tvs: vi.fn() };

  beforeEach(() => {
    api.alerts.mockReset().mockResolvedValue([]);
    api.tvs.mockReset().mockResolvedValue([]);
    api.list.mockReset();
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        { provide: DevicesApi, useValue: api },
        { provide: AuthApi, useValue: { guests: vi.fn().mockResolvedValue([]) } },
        {
          provide: AuthService,
          useValue: { authorized: (call: (token: string) => unknown) => call('token') },
        },
      ],
    });
  });

  it('holds the shape of the device cards as a busy skeleton until the list arrives', async () => {
    let finish: (list: DeviceAgent[]) => void = () => undefined;
    api.list.mockReturnValue(new Promise<DeviceAgent[]>((resolve) => (finish = resolve)));
    const fixture = TestBed.createComponent(DevicesPage);
    await fixture.whenStable();
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;

    expect(
      el.querySelector('app-loading-skeleton app-loading-frame[aria-busy="true"]'),
    ).not.toBeNull();
    expect(el.querySelectorAll('app-loading-skeleton .card')).toHaveLength(2);
    expect(el.querySelector('.item')).toBeNull();

    finish([PC]);
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(el.querySelector('app-loading-skeleton')).toBeNull();
    });
    expect(el.querySelector('.item .name')?.textContent).toBe('PC de casa');
  });

  it('drops the skeleton for the error with its retry instead of shimmering forever', async () => {
    api.list.mockRejectedValue(new Error('sem rede'));
    const fixture = TestBed.createComponent(DevicesPage);
    await fixture.whenStable();
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;

    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(el.querySelector('app-loading-skeleton')).toBeNull();
    });
    expect(el.textContent).toContain('Tentar de novo');
  });
});
