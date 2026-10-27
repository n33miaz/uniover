import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { SessionState } from '../../core/session/session-state';
import { SystemApi, SystemSettingValue } from './system-api';
import { SystemPage } from './system.page';
import { SystemTvSection } from './system-tv-section';

@Component({ selector: 'app-system-tv-section', template: '' })
class FakeTvSection {}

const initial: SystemSettingValue[] = [
  { key: 'training.off-contact', value: 'server@example.test', source: 'server' },
  { key: 'devices.max-per-guest', value: 2, source: 'server' },
  { key: 'training.photo-storage-enabled', value: false, source: 'server' },
];

describe('SystemPage configuration', () => {
  const api = { systemSettings: vi.fn(), saveSystemSetting: vi.fn() };

  beforeEach(() => {
    api.systemSettings.mockReset().mockResolvedValue(initial);
    api.saveSystemSetting.mockReset().mockImplementation(async (key: string, value: unknown) => ({
      key,
      value,
      source: 'app',
    }));
    TestBed.configureTestingModule({ providers: [{ provide: SystemApi, useValue: api }] });
    TestBed.overrideComponent(SystemPage, {
      remove: { imports: [SystemTvSection] },
      add: { imports: [FakeTvSection] },
    });
  });

  afterEach(() => localStorage.clear());

  async function render(role: 'owner' | 'guest') {
    const session = TestBed.inject(SessionState);
    session.setToken('t', 600);
    session.setUser({ id: '1', email: 'a@b.c', displayName: 'Dono', role });
    const fixture = TestBed.createComponent(SystemPage);
    await fixture.whenStable();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    return { fixture, el: fixture.nativeElement as HTMLElement };
  }

  it('shows current values and source, then saves a changed limit', async () => {
    const { fixture, el } = await render('owner');
    expect(el.textContent).toContain('do servidor');
    const limit = el.querySelector<HTMLInputElement>('#guest-limit')!;
    expect(limit.value).toBe('2');
    limit.value = '4';
    limit.dispatchEvent(new Event('input'));
    el.querySelectorAll<HTMLFormElement>('form')[1].dispatchEvent(
      new Event('submit', { cancelable: true }),
    );
    await fixture.whenStable();
    fixture.detectChanges();
    expect(api.saveSystemSetting).toHaveBeenCalledWith('devices.max-per-guest', 4);
    expect(el.textContent).toContain('do app');
    expect(el.textContent).toContain('Configuração salva.');
  });

  it('does not request administrator settings for a guest', async () => {
    await render('guest');
    expect(api.systemSettings).not.toHaveBeenCalled();
  });
});
