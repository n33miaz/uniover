import { HttpErrorResponse } from '@angular/common/http';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { SessionState } from '../../../core/session/session-state';
import { ClockService } from '../../../core/time/clock.service';
import { TvApi } from '../data/tv-api';
import { makeShortcut } from '../tv-test-kit';
import { TvLivreApi } from './data/livre-api';
import { TvLivreStore } from './data/livre-store';
import { DEFAULT_LIVRE_CONFIG, TvLivreView } from './data/livre-types';
import { LIVRE_PHOTO_REDUCER } from './data/photo-fit';
import { LivrePage } from './livre.page';

const APPS = [
  { package: 'com.exemplo.alfa', factory: false, disabled: false },
  { package: 'com.exemplo.beta', factory: false, disabled: false },
  { package: 'com.exemplo.gama', factory: false, disabled: false },
  { package: 'com.exemplo.fabrica', factory: true, disabled: false },
];

function view(overrides: Partial<TvLivreView> = {}): TvLivreView {
  return {
    available: true,
    supported: true,
    installed: false,
    version: null,
    isHome: false,
    factoryLauncher: null,
    disabledPackages: [],
    apps: APPS,
    stateAt: '2026-10-31T12:00:00Z',
    config: DEFAULT_LIVRE_CONFIG,
    hasPhoto: false,
    revision: 0,
    ...overrides,
  };
}

describe('LivrePage', () => {
  const api = {
    get: vi.fn(),
    refresh: vi.fn(),
    saveConfig: vi.fn(),
    apply: vi.fn(),
    install: vi.fn(),
    setHome: vi.fn(),
    restore: vi.fn(),
    sleep: vi.fn(),
    putPhoto: vi.fn(),
    photo: vi.fn(),
    deletePhoto: vi.fn(),
  };
  const tvApi = { shortcuts: vi.fn() };
  const reducer = vi.fn();
  let fixture: ComponentFixture<LivrePage>;
  let el: HTMLElement;

  beforeEach(() => {
    for (const fn of [...Object.values(api), tvApi.shortcuts, reducer]) fn.mockReset();
    api.get.mockResolvedValue(view());
    api.photo.mockResolvedValue(null);
    tvApi.shortcuts.mockResolvedValue([
      makeShortcut(1, { package: 'com.exemplo.alfa', tvLabel: 'Alfa' }),
      makeShortcut(2, { package: 'com.exemplo.beta', tvLabel: 'Beta' }),
      makeShortcut(3, { package: 'com.exemplo.gama', tvLabel: 'Gama' }),
      makeShortcut(4, { package: 'com.exemplo.fabrica', tvLabel: 'Fábrica' }),
    ]);
    TestBed.configureTestingModule({
      providers: [
        { provide: TvLivreApi, useValue: api },
        { provide: TvApi, useValue: tvApi },
        { provide: LIVRE_PHOTO_REDUCER, useValue: reducer },
      ],
    });
    TestBed.inject(ClockService).now.set(new Date('2026-10-31T21:05:00'));
    TestBed.inject(SessionState).setUser({
      id: 'conta-dono',
      email: 'dono@exemplo.com',
      displayName: 'Dono',
      role: 'owner',
    });
  });

  afterEach(() => localStorage.clear());

  async function render(): Promise<void> {
    fixture = TestBed.createComponent(LivrePage);
    el = fixture.nativeElement as HTMLElement;
    await fixture.whenStable();
    TestBed.tick();
    await fixture.whenStable();
  }

  const q = <T extends HTMLElement>(selector: string) => el.querySelector<T>(selector)!;
  const qa = <T extends HTMLElement>(selector: string) =>
    Array.from(el.querySelectorAll<T>(selector));
  const tab = (label: string) =>
    qa<HTMLButtonElement>('[role="tab"]').find((t) => t.textContent?.trim() === label)!;
  const button = (label: string) =>
    qa<HTMLButtonElement>('button, label.ui-btn').find((b) => b.textContent?.trim() === label);

  async function open(label: string) {
    tab(label).click();
    await fixture.whenStable();
    fixture.detectChanges();
  }

  async function change() {
    await fixture.whenStable();
    fixture.detectChanges();
  }

  describe('loading', () => {
    it('shows a skeleton of the screen, with a label for the screen reader, until the state arrives', async () => {
      let release!: (value: TvLivreView) => void;
      api.get.mockReturnValue(new Promise<TvLivreView>((resolve) => (release = resolve)));
      fixture = TestBed.createComponent(LivrePage);
      el = fixture.nativeElement as HTMLElement;
      fixture.detectChanges();
      await Promise.resolve();
      fixture.detectChanges();
      expect(el.querySelector('app-loading-frame')).not.toBeNull();
      expect(el.querySelector('[role="status"]')?.textContent).toContain('Carregando o TV Livre');
      expect(el.querySelectorAll('.ui-skeleton').length).toBeGreaterThan(0);
      expect(el.querySelector('[role="tablist"]')).toBeNull();
      release(view());
      await vi.waitFor(() => {
        fixture.detectChanges();
        expect(el.querySelector('app-loading-frame')).toBeNull();
      });
      expect(el.querySelector('[role="tablist"]')).not.toBeNull();
    });

    it('says what went wrong in a short sentence and reads again on "Tentar de Novo"', async () => {
      api.get.mockRejectedValueOnce(new Error('rede'));
      await render();
      expect(q('[role="alert"]').textContent).toContain('Não foi possível');
      expect(el.querySelector('[role="tablist"]')).toBeNull();
      button('Tentar de Novo')!.click();
      await change();
      expect(el.querySelector('[role="tablist"]')).not.toBeNull();
    });
  });

  describe('tabs', () => {
    it('has the four screens, in order, with the first selected', async () => {
      await render();
      expect(qa('[role="tab"]').map((t) => t.textContent?.trim())).toEqual([
        'Home da TV',
        'Fundo',
        'Dormir',
        'Instalação',
      ]);
      expect(tab('Home da TV').getAttribute('aria-selected')).toBe('true');
      expect(tab('Fundo').getAttribute('aria-selected')).toBe('false');
      expect(tab('Fundo').getAttribute('tabindex')).toBe('-1');
      expect(q('[role="tabpanel"]').getAttribute('aria-labelledby')).toBe('livre-tab-home');
      expect(el.querySelector('app-livre-home-tab')).not.toBeNull();
    });

    it('switches the screen on touch and moves the selection with the arrow keys, Home and End', async () => {
      await render();
      await open('Fundo');
      expect(el.querySelector('app-livre-background-tab')).not.toBeNull();
      expect(el.querySelector('app-livre-home-tab')).toBeNull();

      tab('Fundo').dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }),
      );
      await change();
      expect(tab('Dormir').getAttribute('aria-selected')).toBe('true');
      tab('Dormir').dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
      await change();
      expect(tab('Instalação').getAttribute('aria-selected')).toBe('true');
      tab('Instalação').dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }),
      );
      await change();
      expect(tab('Home da TV').getAttribute('aria-selected')).toBe('true');
      tab('Home da TV').dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }),
      );
      await change();
      expect(tab('Instalação').getAttribute('aria-selected')).toBe('true');
    });
  });

  describe('Aplicar na TV', () => {
    it('is on the screens that edit the configuration, not on Instalação', async () => {
      await render();
      for (const label of ['Home da TV', 'Fundo', 'Dormir']) {
        await open(label);
        expect(button('Aplicar na TV'), label).toBeDefined();
      }
      await open('Instalação');
      expect(button('Aplicar na TV')).toBeUndefined();
    });

    it('saves and applies, showing the busy state and then the result', async () => {
      await render();
      let release!: (value: TvLivreView) => void;
      api.saveConfig.mockReturnValue(new Promise<TvLivreView>((resolve) => (release = resolve)));
      api.apply.mockResolvedValue(view({ revision: 1 }));
      button('Aplicar na TV')!.click();
      await change();
      expect(button('Aplicando…')!.getAttribute('aria-busy')).toBe('true');
      expect(button('Aplicando…')!.disabled).toBe(true);
      release(view());
      await change();
      await change();
      expect(api.saveConfig).toHaveBeenCalledTimes(1);
      expect(api.apply).toHaveBeenCalledTimes(1);
      expect(q('.ui-action-bar .ui-notice').textContent).toContain('Aplicado na TV.');
      expect(q('.ui-action-bar .ui-notice').getAttribute('role')).toBe('status');
    });

    it('shows a failure as an alert, translated, and keeps the button for another try', async () => {
      await render();
      api.saveConfig.mockResolvedValue(view());
      api.apply.mockRejectedValue(new Error('x'));
      button('Aplicar na TV')!.click();
      await change();
      await change();
      const notice = q('.ui-action-bar .ui-notice');
      expect(notice.getAttribute('role')).toBe('alert');
      expect(notice.textContent).toContain('Salvo, mas a TV não aplicou.');
      expect(button('Aplicar na TV')!.disabled).toBe(false);
    });
  });

  describe('a TV that cannot be used', () => {
    it('shows only the reason, with no way to apply, when the TV is not compatible', async () => {
      api.get.mockResolvedValue(view({ supported: false }));
      await render();
      expect(q('.ui-notice.warn').textContent).toContain('Esta TV não é compatível');
      expect(button('Aplicar na TV')).toBeUndefined();
      await open('Instalação');
      expect(button('Voltar ao Original')).toBeUndefined();
      expect(button('Instalar')).toBeUndefined();
    });

    it('keeps "Voltar ao Original" on the screen, but off, when the agent is out of reach', async () => {
      api.get.mockResolvedValue(view({ available: false, supported: true }));
      await render();
      expect(q('.ui-notice.warn').textContent).toContain('fora do ar');
      expect(button('Aplicar na TV')).toBeUndefined();
      await open('Instalação');
      expect(button('Voltar ao Original')!.disabled).toBe(true);
      expect(button('Instalar')!.disabled).toBe(true);
    });

    it('reads the state again from the notice of the agent that is out of reach', async () => {
      api.get.mockResolvedValue(view({ available: false, supported: true }));
      await render();
      api.get.mockResolvedValue(view());
      button('Tentar de Novo')!.click();
      await change();
      expect(el.querySelector('.ui-notice.warn')).toBeNull();
    });
  });

  describe('Home da TV', () => {
    it('draws the preview with the clock, the date and the apps that will show, and no system name', async () => {
      await render();
      const preview = q('app-livre-preview');
      expect(preview.querySelector('[role="img"]')?.getAttribute('aria-label')).toBe(
        'Pré-visualização da Home da TV',
      );
      expect(preview.querySelector('.time')?.textContent).toBe('21:05');
      expect(preview.querySelector('.date')?.textContent).toBe('sábado, 31 de outubro');
      // Sem escolha: todos os que não são de fábrica, por nome (a fileira também traz o círculo de Configurações).
      expect(Array.from(preview.querySelectorAll('.name')).map((name) => name.textContent)).toEqual(
        ['Alfa', 'Beta', 'Gama'],
      );
      expect(preview.textContent).not.toContain('UniOver');
      expect(preview.querySelectorAll('app-tv-app-icon')).toHaveLength(3);
    });

    it('lists every installed app, with the factory ones folded away and off', async () => {
      await render();
      const names = qa('.app .name').map((name) => name.textContent);
      expect(names).toEqual(['Alfa', 'Beta', 'Gama']);
      const fold = q<HTMLButtonElement>('.fold');
      expect(fold.getAttribute('aria-expanded')).toBe('false');
      expect(fold.textContent).toContain('De Fábrica');
      fold.click();
      await change();
      expect(qa('#livre-factory .name').map((name) => name.textContent)).toEqual(['Fábrica']);
      const factorySwitch = q<HTMLInputElement>('#livre-factory input[role="switch"]');
      expect(factorySwitch.checked).toBe(false);
    });

    it('chooses apps in order and lets the person move them with accessible buttons', async () => {
      await render();
      const toggle = (label: string) =>
        q<HTMLInputElement>(`input[aria-label="Mostrar ${label} na Home"]`);
      toggle('Gama').click();
      await change();
      toggle('Alfa').click();
      await change();
      expect(
        qa('.app .name')
          .slice(0, 2)
          .map((n) => n.textContent),
      ).toEqual(['Gama', 'Alfa']);
      expect(
        Array.from(q('app-livre-preview').querySelectorAll('.name')).map((n) => n.textContent),
      ).toEqual(['Gama', 'Alfa']);

      q<HTMLButtonElement>('button[aria-label="Subir Alfa"]').click();
      await change();
      expect(
        qa('.app .name')
          .slice(0, 2)
          .map((n) => n.textContent),
      ).toEqual(['Alfa', 'Gama']);
      expect(q<HTMLButtonElement>('button[aria-label="Subir Alfa"]').disabled).toBe(true);
      expect(q<HTMLButtonElement>('button[aria-label="Descer Gama"]').disabled).toBe(true);
      q<HTMLButtonElement>('button[aria-label="Descer Alfa"]').click();
      await change();
      expect(
        qa('.app .name')
          .slice(0, 2)
          .map((n) => n.textContent),
      ).toEqual(['Gama', 'Alfa']);
    });

    it('sends the chosen apps in order when applying', async () => {
      await render();
      q<HTMLInputElement>('input[aria-label="Mostrar Beta na Home"]').click();
      await change();
      api.saveConfig.mockResolvedValue(view());
      api.apply.mockResolvedValue(view());
      button('Aplicar na TV')!.click();
      await change();
      expect(api.saveConfig.mock.calls[0][0].apps).toEqual({
        mode: 'listed',
        items: ['com.exemplo.beta'],
        hidden: [],
        showFactory: false,
      });
    });
  });

  describe('Fundo', () => {
    beforeEach(async () => {
      await render();
      await open('Fundo');
    });

    it('changes the gradient in the preview when a color is picked', async () => {
      const stage = q('app-livre-preview .stage');
      expect(stage.style.background).toContain('linear-gradient');
      const first = q<HTMLInputElement>('.color input');
      first.value = '#ff0000';
      first.dispatchEvent(new Event('input', { bubbles: true }));
      await change();
      expect(q('app-livre-preview .stage').style.background).toContain('rgb(255, 0, 0)');
    });

    it('applies a ready-made combination and marks it as the chosen one', async () => {
      const presets = qa<HTMLButtonElement>('.preset');
      expect(presets.length).toBeGreaterThanOrEqual(4);
      expect(presets[0].getAttribute('aria-pressed')).toBe('true');
      presets[2].click();
      await change();
      expect(qa<HTMLButtonElement>('.preset')[2].getAttribute('aria-pressed')).toBe('true');
      expect(qa<HTMLButtonElement>('.preset')[0].getAttribute('aria-pressed')).toBe('false');
    });

    it('offers the photo instead of the colors, and says there is none yet', async () => {
      q<HTMLInputElement>('input[name="livre-wallpaper"]:not(:checked)').click();
      await change();
      expect(el.querySelector('.colors')).toBeNull();
      expect(button('Escolher Foto')).toBeDefined();
      expect(button('Remover Foto')).toBeUndefined();
      expect(q('.hint').textContent).toContain('Sem foto');
    });

    it('reduces the chosen photo, sends it, and then offers to remove it and to dim it', async () => {
      q<HTMLInputElement>('input[name="livre-wallpaper"]:not(:checked)').click();
      await change();
      const jpeg = new Blob([new Uint8Array([0xff, 0xd8, 0xff])], { type: 'image/jpeg' });
      reducer.mockResolvedValue({
        status: 'ok',
        blob: jpeg,
        size: { width: 8, height: 8 },
        quality: 0.8,
      });
      api.putPhoto.mockResolvedValue(undefined);
      const input = q<HTMLInputElement>('input[type="file"]');
      Object.defineProperty(input, 'files', {
        value: [new File(['png'], 'foto.png', { type: 'image/png' })],
        configurable: true,
      });
      input.dispatchEvent(new Event('change', { bubbles: true }));
      await vi.waitFor(() => expect(api.putPhoto).toHaveBeenCalledWith(jpeg));
      await change();
      await change();
      expect(button('Remover Foto')).toBeDefined();
      expect(q('.ui-action-bar .ui-notice').textContent).toContain('Foto salva.');
      expect(el.querySelector('app-livre-preview img.photo')).not.toBeNull();
      const dim = q<HTMLInputElement>('#livre-dim');
      expect(dim.max).toBe('80');
      dim.value = '50';
      dim.dispatchEvent(new Event('input', { bubbles: true }));
      await change();
      expect(q('app-livre-preview .dim').style.opacity).toBe('0.5');
    });

    it('shows why a photo was not accepted, without sending it', async () => {
      q<HTMLInputElement>('input[name="livre-wallpaper"]:not(:checked)').click();
      await change();
      reducer.mockResolvedValue({ status: 'invalid' });
      const input = q<HTMLInputElement>('input[type="file"]');
      Object.defineProperty(input, 'files', {
        value: [new File(['x'], 'nao-e-foto.png')],
        configurable: true,
      });
      input.dispatchEvent(new Event('change', { bubbles: true }));
      await vi.waitFor(() => expect(reducer).toHaveBeenCalled());
      await change();
      await change();
      expect(api.putPhoto).not.toHaveBeenCalled();
      expect(q('.ui-action-bar .ui-notice').textContent).toContain('Não deu para ler esta foto.');
    });
  });

  describe('Dormir', () => {
    beforeEach(async () => {
      await render();
      await open('Dormir');
    });

    it('has the big button, and says that any key wakes the TV', async () => {
      expect(button('Modo Dormir')).toBeDefined();
      expect(el.textContent).toContain('Qualquer tecla do controle acorda a TV.');
    });

    it('sends the sleep command and tells the person', async () => {
      api.sleep.mockResolvedValue(undefined);
      button('Modo Dormir')!.click();
      await change();
      await change();
      expect(api.sleep).toHaveBeenCalledTimes(1);
      expect(q('.ui-action-bar .ui-notice').textContent).toContain('Modo Dormir enviado');
    });

    it('keeps the time to wake up by itself in the configuration, between 0 and 720', async () => {
      const field = q<HTMLInputElement>('#livre-sleep-max');
      expect(field.value).toBe('0');
      field.value = '90';
      field.dispatchEvent(new Event('change', { bubbles: true }));
      await change();
      field.value = '9999';
      field.dispatchEvent(new Event('change', { bubbles: true }));
      await change();
      expect(field.value).toBe('720');
      api.saveConfig.mockResolvedValue(view());
      api.apply.mockResolvedValue(view());
      button('Aplicar na TV')!.click();
      await change();
      expect(api.saveConfig.mock.calls[0][0].sleep).toEqual({ maxMinutes: 720 });
    });
  });

  describe('Instalação', () => {
    async function openInstall(overrides: Partial<TvLivreView> = {}) {
      api.get.mockResolvedValue(view(overrides));
      await render();
      await open('Instalação');
    }

    it('shows the state of the TV Livre in the TV', async () => {
      await openInstall({ installed: true, version: '1.2.0', isHome: false });
      const rows = qa('.status .ui-row').map((row) => row.textContent?.replace(/\s+/g, ' ').trim());
      expect(rows[0]).toContain('Versão 1.2.0');
      expect(rows[0]).toContain('Sim');
      expect(rows[1]).toContain('Não');
    });

    it('follows the safe order: install first, set as default only after it is installed', async () => {
      await openInstall({ installed: false });
      expect(button('Instalar')!.classList.contains('primary')).toBe(true);
      expect(button('Definir Como Padrão')!.disabled).toBe(true);
      api.install.mockResolvedValue(view({ installed: true, version: '1.0.0' }));
      button('Instalar')!.click();
      await change();
      await change();
      expect(api.install).toHaveBeenCalledTimes(1);
      expect(button('Definir Como Padrão')!.disabled).toBe(false);
      expect(button('Definir Como Padrão')!.classList.contains('primary')).toBe(true);
    });

    it('turns off the factory launcher only when asked, which starts off', async () => {
      await openInstall({ installed: true });
      const option = q<HTMLInputElement>('.option input');
      expect(option.checked).toBe(false);
      api.setHome.mockResolvedValue(view({ installed: true, isHome: true }));
      button('Definir Como Padrão')!.click();
      await change();
      expect(api.setHome).toHaveBeenLastCalledWith(false);
      await change();
      expect(button('Definir Como Padrão')!.disabled).toBe(true);
    });

    it('sends disableFactory when the option is on', async () => {
      await openInstall({ installed: true });
      q<HTMLInputElement>('.option input').click();
      await change();
      api.setHome.mockResolvedValue(view({ installed: true, isHome: true }));
      button('Definir Como Padrão')!.click();
      await change();
      expect(api.setHome).toHaveBeenLastCalledWith(true);
    });

    it('always shows "Voltar ao Original" for a compatible TV, even before installing', async () => {
      await openInstall({ installed: false });
      expect(button('Voltar ao Original')).toBeDefined();
    });

    it('asks before going back to the original, and does nothing on Cancelar', async () => {
      await openInstall({ installed: true, isHome: true });
      button('Voltar ao Original')!.click();
      await change();
      expect(q('.ask').textContent).toContain('Voltar à tela de fábrica');
      expect(api.restore).not.toHaveBeenCalled();
      button('Cancelar')!.click();
      await change();
      expect(api.restore).not.toHaveBeenCalled();
      expect(el.querySelector('.ask')).toBeNull();
      expect(button('Voltar ao Original')).toBeDefined();
    });

    it('goes back to the original after the confirmation and shows the result', async () => {
      await openInstall({ installed: true, isHome: true });
      api.restore.mockResolvedValue(view({ installed: false, isHome: false }));
      button('Voltar ao Original')!.click();
      await change();
      button('Voltar ao Original')!.click();
      await change();
      await change();
      expect(api.restore).toHaveBeenCalledTimes(1);
      expect(q('.ui-notice.ok').textContent).toContain('A TV voltou ao original.');
      expect(button('Voltar ao Original')).toBeDefined();
    });

    it('shows the error of the agent, translated, and keeps the exit available', async () => {
      await openInstall({ installed: false });
      api.install.mockRejectedValue(
        new HttpErrorResponse({
          status: 502,
          error: {
            type: 'https://uniover.app/problems/command-failed',
            agentError: 'signature_mismatch',
          },
        }),
      );
      button('Instalar')!.click();
      await change();
      await change();
      expect(q('.ui-notice.bad').textContent).toContain('outra assinatura');
      expect(q('.ui-notice.bad').getAttribute('role')).toBe('alert');
      expect(button('Voltar ao Original')!.disabled).toBe(false);
    });

    it('asks the agent for the state of now with Atualizar', async () => {
      await openInstall({ installed: true });
      api.refresh.mockResolvedValue(view({ installed: true, isHome: true }));
      button('Atualizar')!.click();
      await change();
      await change();
      expect(api.refresh).toHaveBeenCalledTimes(1);
      expect(q('.status').textContent).toContain('Sim');
      expect(q('.ui-notice.ok').textContent).toContain('Estado atualizado.');
    });
  });

  it('reads the state when it opens and stops when it closes, and does not read again by itself', async () => {
    await render();
    expect(api.get).toHaveBeenCalledTimes(1);
    expect(TestBed.inject(TvLivreStore).view()).not.toBeNull();
    fixture.destroy();
    TestBed.tick();
    await Promise.resolve();
    expect(api.get).toHaveBeenCalledTimes(1);
  });
});
