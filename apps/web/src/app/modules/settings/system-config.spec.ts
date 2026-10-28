import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { SessionState } from '../../core/session/session-state';
import { SystemApi, SystemSettingValue } from './system-api';
import { SystemPage } from './system.page';
import { SystemTvSection } from './system-tv-section';
import { SystemHealthSection } from './system-health-section';

@Component({ selector: 'app-system-tv-section', template: '' })
class FakeTvSection {}

@Component({ selector: 'app-system-health-section', template: '' })
class FakeHealthSection {}

const initial: SystemSettingValue[] = [
  { key: 'training.off-contact', value: 'server@example.test', source: 'server' },
  { key: 'devices.max-per-guest', value: 2, source: 'server' },
  { key: 'devices.agent-offline-minutes', value: 10, source: 'server' },
  { key: 'training.photo-storage-enabled', value: false, source: 'server' },
  { key: 'tv.light-cleanup-enabled', value: true, source: 'server' },
  { key: 'tv.deep-cleanup-enabled', value: true, source: 'server' },
  { key: 'tv.deep-cleanup-memory-threshold-mb', value: 160, source: 'server' },
];

/** O botão pelo texto que a pessoa lê (o atributo `i18n` não existe no DOM renderizado). */
function buttonByText(el: HTMLElement, text: string): HTMLButtonElement {
  return Array.from(el.querySelectorAll<HTMLButtonElement>('button')).find((b) =>
    b.textContent?.includes(text),
  )!;
}

describe('SystemPage configuration', () => {
  const api = {
    systemSettings: vi.fn(),
    saveSystemSetting: vi.fn(),
    resetSystemSetting: vi.fn(),
    photoBucket: vi.fn(),
  };

  beforeEach(() => {
    api.systemSettings.mockReset().mockResolvedValue(initial);
    api.photoBucket.mockReset().mockResolvedValue({ configured: true });
    api.saveSystemSetting.mockReset().mockImplementation(async (key: string, value: unknown) => ({
      key,
      value,
      source: 'app',
    }));
    api.resetSystemSetting.mockReset().mockImplementation(async (key: string) => {
      const value = initial.find((item) => item.key === key)!;
      return value;
    });
    TestBed.configureTestingModule({ providers: [{ provide: SystemApi, useValue: api }] });
    TestBed.overrideComponent(SystemPage, {
      remove: { imports: [SystemHealthSection, SystemTvSection] },
      add: { imports: [FakeHealthSection, FakeTvSection] },
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

  it('saves the delay before an offline agent becomes an alert', async () => {
    const { fixture, el } = await render('owner');
    const delay = el.querySelector<HTMLInputElement>('#agent-offline-minutes')!;
    expect(delay.value).toBe('10');
    delay.value = '15';
    delay.dispatchEvent(new Event('input'));
    el.querySelectorAll<HTMLFormElement>('form')[2].dispatchEvent(
      new Event('submit', { cancelable: true }),
    );
    await fixture.whenStable();
    expect(api.saveSystemSetting).toHaveBeenCalledWith('devices.agent-offline-minutes', 15);
  });

  it('says the server bucket is ready and keeps the photo switch usable', async () => {
    const { el } = await render('owner');
    expect(el.querySelector('.bucket')?.textContent).toContain('Bucket pronto no servidor.');
    expect(el.querySelector<HTMLInputElement>('#photo-storage')!.disabled).toBe(false);
    expect(el.textContent).toContain('nuvem privada');
  });

  it('warns that the bucket is missing and blocks turning the photos on', async () => {
    api.photoBucket.mockResolvedValue({ configured: false });
    const { el } = await render('owner');
    expect(el.querySelector('.bucket')?.textContent).toContain('ainda não configurado');
    expect(el.querySelector<HTMLInputElement>('#photo-storage')!.disabled).toBe(true);
  });

  it('keeps the photo switch off the hook when the bucket status cannot be read', async () => {
    api.photoBucket.mockRejectedValue(new Error('offline'));
    const { el } = await render('owner');
    expect(el.querySelector('.bucket')).toBeNull();
    expect(el.querySelector<HTMLInputElement>('#photo-storage')!.disabled).toBe(false);
  });

  it('lets an already enabled photo switch be turned off even if the bucket went missing', async () => {
    api.photoBucket.mockResolvedValue({ configured: false });
    api.systemSettings.mockResolvedValue(
      initial.map((item) =>
        item.key === 'training.photo-storage-enabled' ? { ...item, value: true } : item,
      ),
    );
    const { el } = await render('owner');
    expect(el.querySelector<HTMLInputElement>('#photo-storage')!.disabled).toBe(false);
  });

  it('shows the automatic cleanup switches and saves their values', async () => {
    const { fixture, el } = await render('owner');
    const light = el.querySelector<HTMLInputElement>('#light-cleanup')!;
    light.checked = false;
    light.dispatchEvent(new Event('change'));
    buttonByText(el, 'Salvar Limpeza Leve').click();
    await fixture.whenStable();
    expect(api.saveSystemSetting).toHaveBeenCalledWith('tv.light-cleanup-enabled', false);
    expect(el.querySelector<HTMLInputElement>('#deep-cleanup-threshold')!.value).toBe('160');
  });

  it('restores all cleanup settings to their server defaults together', async () => {
    const { fixture, el } = await render('owner');
    buttonByText(el, 'Voltar ao Padrão da Limpeza').click();
    await fixture.whenStable();
    expect(api.resetSystemSetting).toHaveBeenCalledTimes(3);
  });
});
