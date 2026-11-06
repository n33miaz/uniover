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
});
