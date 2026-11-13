import { By } from '@angular/platform-browser';
import { TestBed } from '@angular/core/testing';
import { UnsavedWork } from '../../core/pwa/unsaved-work';
import { provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { routes } from '../../app.routes';
import { SystemApi, type SystemSettingValue } from './system-api';
import { SystemPage } from './system.page';

describe('system route', () => {
  it('renders the page lazily, inside the shell, under Configurações, with the TV section', async () => {
    TestBed.configureTestingModule({
      providers: [
        provideRouter(routes),
        {
          provide: SystemApi,
          useValue: {
            tvConfig: () => new Promise(() => undefined),
            systemSettings: () => new Promise(() => undefined),
            agents: () => Promise.resolve([]),
            tvs: () => Promise.resolve([]),
            deploymentVersion: () => Promise.resolve({ commit: null }),
          },
        },
      ],
    });
    const harness = await RouterTestingHarness.create();
    await harness.navigateByUrl('/ajustes/sistema');
    const root = harness.routeNativeElement as HTMLElement;
    expect(root.matches('app-shell')).toBe(true);
    expect(root.querySelector('app-system-page app-system-tv-section')).not.toBeNull();
    expect(root.querySelector('h1')?.textContent).toBe('Sistema');
    expect(root.querySelector('h2')?.textContent?.trim()).toBe('TVs');
  });

  describe('the contact e-mail as unsaved work', () => {
    const OFF_CONTACT: SystemSettingValue = {
      key: 'training.off-contact',
      value: 'dono@exemplo.com',
      source: 'server',
    };

    async function openWith(saved: SystemSettingValue[]) {
      TestBed.configureTestingModule({
        providers: [
          provideRouter(routes),
          {
            provide: SystemApi,
            useValue: {
              tvConfig: () => new Promise(() => undefined),
              systemSettings: () => Promise.resolve(saved),
              agents: () => Promise.resolve([]),
              tvs: () => Promise.resolve([]),
              deploymentVersion: () => Promise.resolve({ commit: null }),
            },
          },
        ],
      });
      const harness = await RouterTestingHarness.create();
      await harness.navigateByUrl('/ajustes/sistema');
      const page = harness.fixture.debugElement.query(By.directive(SystemPage))
        .componentInstance as unknown as {
        load(): Promise<void>;
        contact: { set(value: string): void };
        settings: {
          update(change: (items: SystemSettingValue[] | null) => SystemSettingValue[]): void;
        };
      };
      await page.load();
      return page;
    }

    it('is clean while it matches what the server has, dirty once it differs, and clean again after it was saved', async () => {
      const page = await openWith([OFF_CONTACT]);
      const unsaved = TestBed.inject(UnsavedWork);
      expect(unsaved.needsConfirmation()).toBe(false);

      page.contact.set('novo@exemplo.com');
      expect(unsaved.needsConfirmation()).toBe(true);

      // A gravação devolve o valor novo e a tela o guarda como o valor salvo.
      page.settings.update((items) =>
        (items ?? []).map((item) =>
          item.key === 'training.off-contact' ? { ...item, value: 'novo@exemplo.com' } : item,
        ),
      );
      expect(unsaved.needsConfirmation()).toBe(false);
    });

    it('does not count anything before the settings were loaded', async () => {
      const page = await openWith([]);
      page.contact.set('qualquer@exemplo.com');
      expect(TestBed.inject(UnsavedWork).needsConfirmation()).toBe(false);
    });
  });

  describe('the "em breve" modules on the Início', () => {
    const SOON: SystemSettingValue = { key: 'home.soon-modules', value: [], source: 'server' };

    async function openSoon(save: (key: string, value: unknown) => Promise<SystemSettingValue>) {
      TestBed.configureTestingModule({
        providers: [
          provideRouter(routes),
          {
            provide: SystemApi,
            useValue: {
              tvConfig: () => new Promise(() => undefined),
              systemSettings: () => Promise.resolve([SOON]),
              saveSystemSetting: save,
              agents: () => Promise.resolve([]),
              tvs: () => Promise.resolve([]),
              deploymentVersion: () => Promise.resolve({ commit: null }),
            },
          },
        ],
      });
      const harness = await RouterTestingHarness.create();
      await harness.navigateByUrl('/ajustes/sistema');
      const page = harness.fixture.debugElement.query(By.directive(SystemPage))
        .componentInstance as unknown as { load(): Promise<void> };
      await page.load();
      harness.detectChanges();
      const el = harness.routeNativeElement as HTMLElement;
      await vi.waitFor(() => expect(el.querySelector('#soon-health')).not.toBeNull());
      return { harness, el };
    }
    const toggle = (el: HTMLElement, id: string) =>
      el.querySelector<HTMLInputElement>(`#soon-${id}`)!;

    it('lists every module that still has no screen, all off by default', async () => {
      const { el } = await openSoon((_, value) =>
        Promise.resolve({ ...SOON, value: value as string[] }),
      );
      const ids = Array.from(el.querySelectorAll<HTMLInputElement>('input[id^="soon-"]')).map(
        (input) => input.id,
      );
      expect(ids).toEqual([
        'soon-health',
        'soon-monitor',
        'soon-network',
        'soon-backup',
        'soon-notifications',
        'soon-pc',
      ]);
      expect(toggle(el, 'health').checked).toBe(false);
      // Os que já funcionam não são oferecidos: só os "em breve" têm o que liberar.
      expect(el.querySelector('#soon-tv')).toBeNull();
    });

    it('saves the whole list when one is switched on, and again when it is switched off', async () => {
      const saved: unknown[] = [];
      const { harness, el } = await openSoon((key, value) => {
        saved.push([key, value]);
        return Promise.resolve({ ...SOON, value: value as string[], source: 'app' });
      });
      toggle(el, 'health').click();
      await vi.waitFor(() => expect(saved).toHaveLength(1));
      toggle(el, 'backup').click();
      await vi.waitFor(() => expect(saved).toHaveLength(2));
      toggle(el, 'health').click();
      await vi.waitFor(() => expect(saved).toHaveLength(3));
      harness.detectChanges();
      expect(saved).toEqual([
        ['home.soon-modules', ['health']],
        ['home.soon-modules', ['health', 'backup']],
        ['home.soon-modules', ['backup']],
      ]);
    });

    it('puts the switch back when the server refuses', async () => {
      const { el } = await openSoon(() => Promise.reject(new Error('recusado')));
      toggle(el, 'network').click();
      await vi.waitFor(() => expect(el.querySelector('[role="alert"]')).not.toBeNull());
      expect(toggle(el, 'network').checked).toBe(false);
    });
  });
});
