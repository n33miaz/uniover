import { HttpErrorResponse, HttpHeaders } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { AuthApi, GuestSummary } from '../../core/auth/auth-api';
import { AuthService } from '../../core/auth/auth.service';
import { TvPermissionService } from '../../core/tv-permission/tv-permission.service';
import { SystemApi, TvComputer, TvItem } from './system-api';
import { TvEditSheet } from './tv-edit-sheet';

const PROBLEM = 'https://uniover.app/problems/';

function clickBackdrop(dialog: HTMLDialogElement): void {
  Object.defineProperty(dialog, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({ left: 10, top: 10, right: 300, bottom: 500 }),
  });
  dialog.dispatchEvent(
    Object.assign(new MouseEvent('pointerdown', { button: 0, clientX: 0, clientY: 0 }), {
      isPrimary: true,
    }),
  );
  dialog.dispatchEvent(new MouseEvent('click', { clientX: 0, clientY: 0 }));
}

function problem(status: number, kind = '', extra: Record<string, unknown> = {}) {
  return new HttpErrorResponse({
    status,
    headers: new HttpHeaders(),
    error: { type: kind ? PROBLEM + kind : undefined, title: 'x', status, ...extra },
  });
}

const FREE: TvComputer = { slug: 'pc-livre', name: 'Notebook', platform: 'linux', online: true };
const OTHER: TvComputer = {
  slug: 'pc-outro',
  name: 'PC do quarto',
  platform: 'windows',
  online: false,
};
const OWN: TvComputer = {
  slug: 'pc-amigo',
  name: 'PC do Raphael',
  platform: 'windows',
  online: true,
};

const TV: TvItem = {
  id: 'tv-2',
  name: 'Raphael',
  isDefault: false,
  agentSlug: 'pc-amigo',
  kind: 'samsung',
  online: true,
  capabilities: ['tv.remote', 'tv.kind.samsung'],
  allowBackgroundAppClosing: false,
};
const DEFAULT_TV: TvItem = { ...TV, id: 'tv-1', name: 'Sala', isDefault: true, kind: 'android' };

const guest = (
  id: string,
  displayName: string,
  disabledAt: string | null = null,
): GuestSummary => ({
  id,
  displayName,
  email: `${id}@exemplo.com`,
  createdAt: '2026-10-19T15:00:00Z',
  disabledAt,
  pausedAt: null,
  permissions: ['module:tv'],
});

describe('TvEditSheet', () => {
  const api = {
    createTv: vi.fn(),
    updateTv: vi.fn(),
    deleteTv: vi.fn(),
    tvMembers: vi.fn(),
    tvCleanupReports: vi.fn(),
    tvApps: vi.fn(),
    tvFocusCatalog: vi.fn(),
    setTvMembers: vi.fn(),
    nearbyTvs: vi.fn(),
    tvs: vi.fn(),
  };
  const permission = { ask: vi.fn(), waitForGrant: vi.fn(), stillPending: vi.fn() };
  const authApi = { guests: vi.fn() };

  beforeEach(() => {
    api.createTv.mockReset().mockImplementation(async (agentSlug: string, name: string) => ({
      ...TV,
      id: 'tv-novo',
      name,
      agentSlug,
    }));
    api.updateTv.mockReset().mockImplementation(async (id: string, change: Partial<TvItem>) => ({
      ...TV,
      id,
      ...change,
    }));
    api.deleteTv.mockReset().mockResolvedValue(undefined);
    api.tvMembers.mockReset().mockResolvedValue(['g1']);
    api.tvCleanupReports.mockReset().mockResolvedValue([]);
    api.tvApps.mockReset().mockResolvedValue([]);
    api.tvFocusCatalog.mockReset().mockRejectedValue(new Error('sem catálogo neste teste'));
    api.nearbyTvs.mockReset().mockResolvedValue({ status: 'ok', items: [] });
    api.tvs.mockReset().mockResolvedValue([]);
    permission.ask.mockReset().mockResolvedValue('asked');
    permission.waitForGrant.mockReset().mockResolvedValue(true);
    permission.stillPending.mockReset().mockResolvedValue(true);
    api.setTvMembers
      .mockReset()
      .mockImplementation(async (_id: string, ids: readonly string[]) => [...ids]);
    authApi.guests
      .mockReset()
      .mockResolvedValue([
        guest('g1', 'Bia'),
        guest('g2', 'Caio'),
        guest('g3', 'Antiga', '2026-10-01T10:00:00Z'),
      ]);
    TestBed.configureTestingModule({
      providers: [
        { provide: SystemApi, useValue: api },
        { provide: AuthApi, useValue: authApi },
        { provide: TvPermissionService, useValue: permission },
        {
          provide: AuthService,
          useValue: { authorized: (call: (t: string) => unknown) => call('token') },
        },
      ],
    });
  });

  async function render(tv: TvItem | null, computers: TvComputer[]) {
    const fixture = TestBed.createComponent(TvEditSheet);
    fixture.componentRef.setInput('tv', tv);
    fixture.componentRef.setInput('computers', computers);
    const closed: boolean[] = [];
    fixture.componentInstance.closed.subscribe((changed) => closed.push(changed));
    const settle = async () => {
      await fixture.whenStable();
      fixture.detectChanges();
      await fixture.whenStable();
      fixture.detectChanges();
    };
    fixture.detectChanges();
    await settle();
    const el = fixture.nativeElement as HTMLElement;
    const name = () => el.querySelector<HTMLInputElement>('#tv-edit-name')!;
    const type = async (text: string) => {
      name().value = text;
      name().dispatchEvent(new Event('input'));
      await settle();
    };
    const radio = (computerName: string) =>
      Array.from(el.querySelectorAll<HTMLElement>('label.choice'))
        .find((row) => row.querySelector('.ui-row-title')?.textContent?.trim() === computerName)!
        .querySelector<HTMLInputElement>('input')!;
    const pick = async (computerName: string) => {
      radio(computerName).click();
      await settle();
    };
    const person = (personName: string) =>
      Array.from(el.querySelectorAll<HTMLElement>('label.option'))
        .find((row) => row.querySelector('.option-title')?.textContent?.trim() === personName)!
        .querySelector<HTMLInputElement>('input')!;
    const flip = async (personName: string) => {
      person(personName).click();
      await settle();
    };
    const button = (text: string) =>
      Array.from(el.querySelectorAll<HTMLButtonElement>('button')).find(
        (b) => b.textContent?.trim() === text,
      )!;
    const save = async () => {
      el.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
      await settle();
    };
    const error = () => el.querySelector('.error')?.textContent?.replace(/\s+/g, ' ').trim();
    return {
      fixture,
      el,
      name,
      type,
      radio,
      pick,
      person,
      flip,
      button,
      save,
      error,
      settle,
      closed,
    };
  }

  it('opens as a modal sheet with no close button: the exits are Cancelar, Esc and Salvar', async () => {
    const { el, button } = await render(null, [FREE]);
    const dialog = el.querySelector('dialog')!;
    expect(dialog.hasAttribute('open')).toBe(true);
    expect(dialog.getAttribute('aria-labelledby')).toBe('tv-edit-title');
    expect(el.querySelector('#tv-edit-title')?.textContent).toBe('Nova TV');
    expect(button('Cancelar')).toBeDefined();
    expect(button('Salvar')).toBeDefined();
  });

  it('a touch that begins and ends on the backdrop cancels, and focus goes back to the opener', async () => {
    const opener = document.createElement('button');
    document.body.append(opener);
    opener.focus();
    const { el, closed } = await render(null, [FREE]);
    const dialog = el.querySelector('dialog')!;

    clickBackdrop(dialog);

    expect(dialog.open).toBe(false);
    expect(closed).toEqual([false]);
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  describe('creating', () => {
    it('only saves with a name and a computer, and preselects the computer when there is one only', async () => {
      const { radio, button, type } = await render(null, [FREE]);
      expect(radio('Notebook').checked).toBe(true);
      expect(button('Salvar').disabled).toBe(true);
      await type('Quarto');
      expect(button('Salvar').disabled).toBe(false);
      await type('   ');
      expect(button('Salvar').disabled).toBe(true);
    });

    it('with several computers waits for the choice', async () => {
      const { button, type, pick, radio } = await render(null, [FREE, OTHER]);
      await type('Quarto');
      expect(radio('Notebook').checked).toBe(false);
      expect(button('Salvar').disabled).toBe(true);
      await pick('PC do quarto');
      expect(button('Salvar').disabled).toBe(false);
    });

    it('creates with the computer and then replaces the people, in that order', async () => {
      const { type, pick, flip, save, closed } = await render(null, [FREE, OTHER]);
      await type('  Quarto  ');
      await pick('PC do quarto');
      await flip('Caio');
      await save();
      expect(api.createTv).toHaveBeenCalledWith('pc-outro', 'Quarto');
      expect(api.setTvMembers).toHaveBeenCalledWith('tv-novo', ['g2']);
      expect(api.createTv.mock.invocationCallOrder[0]).toBeLessThan(
        api.setTvMembers.mock.invocationCallOrder[0],
      );
      expect(closed).toEqual([true]);
    });

    it('does not touch the people when none was marked', async () => {
      const { type, save, closed } = await render(null, [FREE]);
      await type('Quarto');
      await save();
      expect(api.createTv).toHaveBeenCalledWith('pc-livre', 'Quarto');
      expect(api.setTvMembers).not.toHaveBeenCalled();
      expect(closed).toEqual([true]);
    });

    it('if the TV was created but the people were not, stays open on the created TV and only retries the people', async () => {
      api.setTvMembers.mockRejectedValueOnce(problem(500));
      const { type, flip, save, error, closed, el } = await render(null, [FREE]);
      await type('Quarto');
      await flip('Bia');
      await save();
      expect(error()).toContain('A TV foi salva, mas as pessoas não');
      expect(closed).toEqual([]);
      expect(el.querySelector('#tv-edit-title')?.textContent).toBe('Editar TV');

      await save();
      expect(api.createTv).toHaveBeenCalledTimes(1);
      expect(api.setTvMembers).toHaveBeenCalledTimes(2);
      expect(closed).toEqual([true]);
    });

    it('tells that the computer already has a TV (409) and keeps the sheet open', async () => {
      api.createTv.mockRejectedValueOnce(problem(409));
      const { type, save, error, closed } = await render(null, [FREE]);
      await type('Quarto');
      await save();
      expect(error()).toBe('Esse computador já controla outra TV. Escolha outro.');
      expect(closed).toEqual([]);
    });

    it('says when there is no free computer', async () => {
      const { el, button } = await render(null, []);
      expect(el.textContent).toContain('Nenhum computador livre. Pareie um em Dispositivos.');
      expect(button('Salvar').disabled).toBe(true);
    });
  });

  describe('editing', () => {
    it('starts with the name, the computer and the people of the TV, and saves nothing until something changes', async () => {
      const { name, radio, person, button, el } = await render(TV, [OWN, FREE]);
      expect(el.querySelector('#tv-edit-title')?.textContent).toBe('Editar TV');
      expect(name().value).toBe('Raphael');
      expect(radio('PC do Raphael').checked).toBe(true);
      expect(person('Bia').checked).toBe(true);
      expect(person('Caio').checked).toBe(false);
      expect(api.tvMembers).toHaveBeenCalledWith('tv-2');
      expect(button('Salvar').disabled).toBe(true);
    });

    it('lists only the active accounts', async () => {
      const { el } = await render(TV, [OWN]);
      const names = Array.from(el.querySelectorAll('label.option .option-title')).map((n) =>
        n.textContent?.trim(),
      );
      expect(names).toEqual(['Bia', 'Caio']);
    });

    it('changes only the name when only the name changed', async () => {
      const { type, save, closed } = await render(TV, [OWN, FREE]);
      await type('Quarto');
      await save();
      expect(api.updateTv).toHaveBeenCalledWith('tv-2', { name: 'Quarto' });
      expect(api.setTvMembers).not.toHaveBeenCalled();
      expect(closed).toEqual([true]);
    });

    it('changes only the computer when only the computer changed', async () => {
      const { pick, save } = await render(TV, [OWN, FREE]);
      await pick('Notebook');
      await save();
      expect(api.updateTv).toHaveBeenCalledWith('tv-2', { agentSlug: 'pc-livre' });
    });

    it('sends the complete list of people when only the people changed, and does not touch the TV', async () => {
      const { flip, save, closed } = await render(TV, [OWN]);
      await flip('Caio');
      await flip('Bia');
      await save();
      expect(api.updateTv).not.toHaveBeenCalled();
      expect(api.setTvMembers).toHaveBeenCalledWith('tv-2', ['g2']);
      expect(closed).toEqual([true]);
    });

    it('offers the background app closing switch off by default, only when editing', async () => {
      const edit = await render(TV, [OWN]);
      const toggle = edit.el.querySelector<HTMLInputElement>('label.toggle input')!;
      expect(toggle.checked).toBe(false);
      expect(edit.el.querySelector('label.toggle .toggle-title')?.textContent?.trim()).toBe(
        'Fechar Apps em Segundo Plano',
      );
      expect(edit.button('Salvar').disabled).toBe(true);

      const creating = await render(null, [OWN]);
      expect(creating.el.querySelector('label.toggle')).toBeNull();
    });

    it('shows that the light settings are unsupported on Samsung without offering a switch', async () => {
      const { el } = await render(TV, [OWN]);
      expect(el.textContent).toContain('Não suportado nesta TV.');
      expect(el.textContent).not.toContain('Animações Mais Curtas');
    });

    it('starts every light setting off on an Android TV and sends them together when one is turned on', async () => {
      api.tvApps.mockResolvedValue([
        { package: 'com.example.video', label: 'Vídeo' },
        { package: 'com.example.musica', label: 'Música' },
      ]);
      const android: TvItem = { ...TV, kind: 'android', capabilities: ['tv.remote', 'tv.adb'] };
      const { el, save, settle, closed } = await render(android, [OWN]);
      const switches = () =>
        Array.from(el.querySelectorAll<HTMLInputElement>('label.toggle input')).slice(0, 4);
      expect(switches().map((item) => item.checked)).toEqual([false, false, false, false]);
      expect(el.textContent).toContain('Atualização automática da Play Store');
      expect(el.textContent).toContain('Disponível em breve');

      switches()[0]!.click();
      switches()[3]!.click();
      await settle();
      await save();

      expect(api.updateTv).toHaveBeenCalledWith('tv-2', {
        focusModeEnabled: true,
        shortAnimationsEnabled: false,
        restrictedBackgroundPackages: ['com.example.musica'],
      });
      expect(closed).toEqual([true]);
    });

    const ANDROID: TvItem = { ...TV, kind: 'android', capabilities: ['tv.remote', 'tv.adb'] };

    it('shows the unsupported-TV text for its own 409 and not the computer-in-use one', async () => {
      api.updateTv.mockRejectedValueOnce(problem(409, 'tv-light-settings-unsupported'));
      const { el, save, settle, error } = await render(ANDROID, [OWN]);
      el.querySelector<HTMLInputElement>('label.toggle input')!.click();
      await settle();
      await save();
      expect(error()).toBe('Não Suportado Nesta TV.');
    });

    it('keeps the computer-in-use text for the 409 of another kind', async () => {
      api.updateTv.mockRejectedValueOnce(problem(409));
      const { el, save, settle, error } = await render(ANDROID, [OWN]);
      el.querySelector<HTMLInputElement>('label.toggle input')!.click();
      await settle();
      await save();
      expect(error()).toBe('Esse computador já controla outra TV. Escolha outro.');
    });

    it('explains a 400 on the app list instead of the generic failure', async () => {
      api.updateTv.mockRejectedValueOnce(
        problem(400, 'validation-failed', {
          errors: { restrictedBackgroundPackages: ['inválida'] },
        }),
      );
      const { el, save, settle, error } = await render(ANDROID, [OWN]);
      el.querySelector<HTMLInputElement>('label.toggle input')!.click();
      await settle();
      await save();
      expect(error()).toContain('A lista de apps tem algo inválido');
    });

    it('tells loading, failed (with a retry) and empty apart in the app list', async () => {
      let resolveApps: (value: { package: string; label: string }[]) => void = () => undefined;
      api.tvApps.mockReturnValueOnce(new Promise((resolve) => (resolveApps = resolve)));
      const { el, settle, button } = await render(ANDROID, [OWN]);
      expect(
        el.querySelector('app-loading-skeleton app-loading-frame[aria-busy="true"]'),
      ).not.toBeNull();
      expect(el.textContent).not.toContain('Nenhum app disponível');

      resolveApps([]);
      await settle();
      expect(el.textContent).toContain('Nenhum app disponível para escolher ainda.');
      expect(button('Tentar de Novo')).toBeUndefined();
    });

    it('shows the failure with Tentar de Novo and recovers on the retry', async () => {
      api.tvApps.mockRejectedValueOnce(new Error('falhou'));
      const { el, settle, button } = await render(ANDROID, [OWN]);
      expect(el.textContent).toContain('Não foi possível carregar os apps agora.');
      expect(el.textContent).not.toContain('Nenhum app disponível');

      api.tvApps.mockResolvedValueOnce([{ package: 'com.example.video', label: 'Vídeo' }]);
      button('Tentar de Novo').click();
      await settle();
      expect(el.textContent).toContain('Vídeo');
      expect(el.textContent).not.toContain('Não foi possível carregar os apps agora.');
    });

    describe('the focus mode catalog', () => {
      const WITH_CATALOG: TvItem = {
        ...TV,
        kind: 'android',
        capabilities: ['tv.remote', 'tv.adb', 'tv.light-settings.v1', 'tv.focus-catalog.v1'],
      };
      const DEFAULTS = ['com.google.android.youtube.tv', 'com.netflix.ninja'];
      const focusSwitch = (el: HTMLElement) =>
        Array.from(el.querySelectorAll<HTMLElement>('label.toggle'))
          .find((label) => label.textContent?.trim() === 'Modo Foco')!
          .querySelector<HTMLInputElement>('input')!;
      /** Os interruptores da lista "Apps do Modo Foco", pelo nome que a pessoa lê. */
      const catalog = (el: HTMLElement) => {
        const title = Array.from(el.querySelectorAll<HTMLElement>('p.reports-title')).find((p) =>
          p.textContent?.includes('Apps do Modo Foco'),
        );
        const list = title?.nextElementSibling?.nextElementSibling;
        return Array.from(list?.querySelectorAll<HTMLElement>('label.toggle') ?? []).map(
          (label) => ({
            label: label.querySelector('.toggle-title')?.textContent?.trim(),
            input: label.querySelector<HTMLInputElement>('input')!,
          }),
        );
      };

      beforeEach(() => {
        api.tvFocusCatalog.mockReset().mockResolvedValue({
          packages: DEFAULTS,
          defaults: DEFAULTS,
          isCustom: false,
        });
        api.tvApps.mockResolvedValue([
          { package: 'com.google.android.youtube.tv', label: 'YouTube' },
          { package: 'com.exemplo.cinema', label: 'Cine Exemplo' },
        ]);
      });

      it('only appears with the focus mode on, lists the catalog first and names the apps', async () => {
        const { el, settle } = await render(WITH_CATALOG, [OWN]);
        expect(el.textContent).not.toContain('Apps do Modo Foco');

        focusSwitch(el).click();
        await settle();
        expect(catalog(el).map((row) => [row.label, row.input.checked])).toEqual([
          ['Netflix', true],
          ['YouTube', true],
          ['Cine Exemplo', false],
        ]);
      });

      it('sends only the catalog when only the catalog changed, and keeps the focus switch out of it', async () => {
        const { el, settle, save } = await render(WITH_CATALOG, [OWN]);
        focusSwitch(el).click();
        await settle();
        const rows = catalog(el);
        rows.find((row) => row.label === 'Cine Exemplo')!.input.click();
        rows.find((row) => row.label === 'Netflix')!.input.click();
        await settle();
        focusSwitch(el).click(); // volta ao que estava: só o catálogo mudou
        await settle();

        await save();

        expect(api.updateTv).toHaveBeenCalledExactlyOnceWith('tv-2', {
          focusPackages: ['com.google.android.youtube.tv', 'com.exemplo.cinema'],
        });
      });

      it('does not send the catalog when nothing in it changed', async () => {
        const { el, settle, save } = await render({ ...WITH_CATALOG, focusModeEnabled: false }, [
          OWN,
        ]);
        focusSwitch(el).click();
        await settle();
        await save();

        expect(api.updateTv).toHaveBeenCalledWith(
          'tv-2',
          expect.not.objectContaining({ focusPackages: expect.anything() }),
        );
      });

      it('goes back to the factory list with Voltar ao Padrão', async () => {
        api.tvFocusCatalog.mockResolvedValue({
          packages: ['com.exemplo.cinema'],
          defaults: DEFAULTS,
          isCustom: true,
        });
        const { el, settle, save, button } = await render(
          { ...WITH_CATALOG, focusModeEnabled: true },
          [OWN],
        );
        expect(
          catalog(el)
            .filter((row) => row.input.checked)
            .map((row) => row.label),
        ).toEqual(['Cine Exemplo']);

        button('Voltar ao Padrão').click();
        await settle();
        expect(
          catalog(el)
            .filter((row) => row.input.checked)
            .map((row) => row.label),
        ).toEqual(['Netflix', 'YouTube']);
        await save();
        expect(api.updateTv).toHaveBeenCalledWith('tv-2', { focusPackages: DEFAULTS });
      });

      it('is not offered for an agent that does not announce it', async () => {
        const { el, settle } = await render(
          { ...WITH_CATALOG, capabilities: ['tv.remote', 'tv.adb'] },
          [OWN],
        );
        focusSwitch(el).click();
        await settle();
        expect(el.textContent).not.toContain('Apps do Modo Foco');
      });

      it('does not even ask for the catalog of a Samsung TV', async () => {
        api.tvFocusCatalog.mockClear();
        await render({ ...WITH_CATALOG, kind: 'samsung' }, [OWN]);
        expect(api.tvFocusCatalog).not.toHaveBeenCalled();
      });

      it('hides the list, and the rest of the sheet still works, when the catalog cannot be read', async () => {
        api.tvFocusCatalog.mockRejectedValue(new Error('falhou'));
        const { el, settle } = await render(WITH_CATALOG, [OWN]);
        focusSwitch(el).click();
        await settle();
        expect(el.textContent).not.toContain('Apps do Modo Foco');
        expect(el.textContent).toContain('Animações Mais Curtas');
      });
    });

    describe('the history entry', () => {
      it('is only on a TV that already exists and takes the administrator to its history', async () => {
        const router = TestBed.inject(Router);
        const navigate = vi.spyOn(router, 'navigate').mockResolvedValue(true);
        const { button, settle } = await render(TV, [OWN]);

        button('Histórico').click();
        await settle();

        expect(navigate).toHaveBeenCalledExactlyOnceWith(['/ajustes/tv', 'tv-2', 'historico']);
      });

      it('is not offered while creating a TV', async () => {
        const { button } = await render(null, [FREE]);
        expect(button('Histórico')).toBeUndefined();
      });
    });

    describe('closing the other apps while the focus mode is on', () => {
      const WITH_CLOSING: TvItem = {
        ...TV,
        kind: 'android',
        capabilities: ['tv.remote', 'tv.adb', 'tv.focus-closes-background.v1'],
      };
      const closingSwitch = (el: HTMLElement) =>
        Array.from(el.querySelectorAll<HTMLElement>('label.toggle'))
          .find((label) => label.textContent?.includes('Fechar Outros Apps no Foco'))
          ?.querySelector<HTMLInputElement>('input');
      const focusSwitch = (el: HTMLElement) =>
        Array.from(el.querySelectorAll<HTMLElement>('label.toggle'))
          .find((label) => label.textContent?.trim() === 'Modo Foco')!
          .querySelector<HTMLInputElement>('input')!;

      it('only appears with the focus mode on, and starts off until its own click', async () => {
        const { el, save, settle } = await render(WITH_CLOSING, [OWN]);
        expect(closingSwitch(el)).toBeUndefined();

        focusSwitch(el).click();
        await settle();
        // Ligar o Modo Foco não dá o consentimento de encerrar apps à força.
        expect(closingSwitch(el)?.checked).toBe(false);

        await save();
        expect(api.updateTv).toHaveBeenCalledWith('tv-2', {
          focusModeEnabled: true,
          focusClosesBackground: false,
          shortAnimationsEnabled: false,
          restrictedBackgroundPackages: [],
        });
      });

      it('is turned on only by its own click', async () => {
        const { el, save, settle } = await render(WITH_CLOSING, [OWN]);
        focusSwitch(el).click();
        await settle();
        closingSwitch(el)!.click();
        await settle();
        await save();

        expect(api.updateTv).toHaveBeenCalledWith('tv-2', {
          focusModeEnabled: true,
          focusClosesBackground: true,
          shortAnimationsEnabled: false,
          restrictedBackgroundPackages: [],
        });
      });

      it('can be turned off on its own while the focus mode stays on', async () => {
        const { el, save, settle } = await render(
          { ...WITH_CLOSING, focusModeEnabled: true, focusClosesBackground: true },
          [OWN],
        );
        expect(closingSwitch(el)?.checked).toBe(true);

        closingSwitch(el)!.click();
        await settle();
        await save();

        expect(api.updateTv).toHaveBeenCalledWith('tv-2', {
          focusModeEnabled: true,
          focusClosesBackground: false,
          shortAnimationsEnabled: false,
          restrictedBackgroundPackages: [],
        });
      });

      it('is not offered, and not sent, for a computer whose agent does not announce it', async () => {
        const { el, settle } = await render(ANDROID, [OWN]);
        focusSwitch(el).click();
        await settle();
        expect(closingSwitch(el)).toBeUndefined();
      });

      it('names the apps the focus mode closed in the cleanup list', async () => {
        api.tvApps.mockResolvedValue([{ package: 'com.example.musica', label: 'Música' }]);
        api.tvCleanupReports.mockResolvedValue([
          {
            kind: 'light',
            trigger: 'focus',
            startedAt: '2026-10-28T20:00:00Z',
            durationMs: 900,
            memoryBeforeMb: null,
            memoryAfterMb: null,
            closedApps: 2,
            closedPackages: ['com.example.musica', 'com.example.jogo'],
            backgroundProcesses: null,
            sessionOpenMs: null,
            result: 'completed',
            reason: null,
          },
        ]);
        const { el } = await render(WITH_CLOSING, [OWN]);
        expect(el.querySelector('.report .report-title')?.textContent).toContain('Modo Foco');
        expect(el.querySelector('.report')?.textContent).toContain('Fechou 2 apps');
        expect(el.querySelector('.report')?.textContent).toContain('Música, com.example.jogo');
      });
    });

    it('turns every light setting off with Voltar ao Original so the agent restores the values it read', async () => {
      const android: TvItem = {
        ...TV,
        kind: 'android',
        capabilities: ['tv.remote', 'tv.adb'],
        focusModeEnabled: true,
        shortAnimationsEnabled: true,
        restrictedBackgroundPackages: ['com.example.video'],
      };
      const { button, save, settle } = await render(android, [OWN]);
      button('Voltar ao Original').click();
      await settle();
      await save();

      expect(api.updateTv).toHaveBeenCalledWith('tv-2', {
        focusModeEnabled: false,
        shortAnimationsEnabled: false,
        restrictedBackgroundPackages: [],
      });
    });

    it('sends only the background app closing option when only the switch changed', async () => {
      const { el, save, settle, closed } = await render(TV, [OWN]);
      el.querySelector<HTMLInputElement>('label.toggle input')!.click();
      await settle();
      await save();
      expect(api.updateTv).toHaveBeenCalledWith('tv-2', { allowBackgroundAppClosing: true });
      expect(api.setTvMembers).not.toHaveBeenCalled();
      expect(closed).toEqual([true]);
    });

    it('starts the switch on for a TV that already allows it, and sends off when it is flipped back', async () => {
      const { el, save, settle } = await render({ ...TV, allowBackgroundAppClosing: true }, [OWN]);
      const toggle = el.querySelector<HTMLInputElement>('label.toggle input')!;
      expect(toggle.checked).toBe(true);
      toggle.click();
      await settle();
      await save();
      expect(api.updateTv).toHaveBeenCalledWith('tv-2', { allowBackgroundAppClosing: false });
    });

    it('lists the latest cleanups with what each one did or why it was skipped', async () => {
      api.tvCleanupReports.mockResolvedValue([
        {
          kind: 'light',
          trigger: 'automatic',
          startedAt: '2026-10-27T11:05:00Z',
          durationMs: 800,
          memoryBeforeMb: 200,
          memoryAfterMb: 260,
          closedApps: 0,
          closedPackages: [],
          backgroundProcesses: 12,
          sessionOpenMs: null,
          result: 'completed',
          reason: null,
        },
        {
          kind: 'deep',
          trigger: 'automatic',
          startedAt: '2026-10-27T10:05:00Z',
          durationMs: 0,
          memoryBeforeMb: null,
          memoryAfterMb: null,
          closedApps: 0,
          closedPackages: [],
          backgroundProcesses: null,
          sessionOpenMs: null,
          result: 'skipped',
          reason: 'media-in-use',
        },
      ]);
      const { el } = await render(TV, [OWN]);
      expect(api.tvCleanupReports).toHaveBeenCalledWith('tv-2');
      const lines = Array.from(el.querySelectorAll('.report .report-outcome')).map((n) =>
        n.textContent?.trim(),
      );
      expect(lines).toEqual(['Liberou 60 MB', 'Pulada: TV em uso']);
      expect(el.querySelector('.report .report-title')?.textContent).toContain('Leve automática');
    });

    it('does not ask for cleanups when creating a TV', async () => {
      const { el } = await render(null, [OWN]);
      expect(api.tvCleanupReports).not.toHaveBeenCalled();
      expect(el.querySelector('.report')).toBeNull();
    });

    it('treats the same people in another order as no change', async () => {
      api.tvMembers.mockResolvedValue(['g2', 'g1']);
      const { flip, button } = await render(TV, [OWN]);
      await flip('Caio');
      await flip('Caio');
      expect(button('Salvar').disabled).toBe(true);
    });

    it('explains that the passkey was not confirmed, and that nothing changed', async () => {
      api.updateTv.mockRejectedValueOnce(
        problem(403, 'step-up-required', { code: 'step_up_required' }),
      );
      const { type, save, error, closed } = await render(TV, [OWN]);
      await type('Quarto');
      await save();
      expect(error()).toBe('A mudança não foi confirmada com a passkey. Nada foi alterado.');
      expect(closed).toEqual([]);
    });

    it('explains a missing TV (404) and a network failure', async () => {
      api.updateTv.mockRejectedValueOnce(problem(404));
      const { type, save, error } = await render(TV, [OWN]);
      await type('Quarto');
      await save();
      expect(error()).toBe('Essa TV não existe mais. Feche e veja a lista.');

      api.updateTv.mockRejectedValueOnce(new HttpErrorResponse({ status: 0 }));
      await save();
      expect(error()).toBe('Sem conexão com o servidor. Tente de novo.');
    });

    it('cancels without any request, saying nothing changed', async () => {
      const { button, settle, closed } = await render(TV, [OWN]);
      button('Cancelar').click();
      await settle();
      expect(closed).toEqual([false]);
      expect(api.updateTv).not.toHaveBeenCalled();
    });

    it('keeps the sheet usable when the people cannot be loaded, saying so', async () => {
      authApi.guests.mockRejectedValue(problem(500));
      const { el, type, save } = await render(TV, [OWN]);
      expect(el.querySelector('[role="alert"]')?.textContent).toContain(
        'Não foi possível carregar as pessoas',
      );
      await type('Quarto');
      await save();
      expect(api.updateTv).toHaveBeenCalledWith('tv-2', { name: 'Quarto' });
    });

    it('says when nobody else has an account yet, and offers no switch', async () => {
      authApi.guests.mockResolvedValue([]);
      const { el } = await render(TV, [OWN]);
      expect(el.textContent).toContain('Ninguém mais tem conta ainda.');
      expect(el.querySelector('label.option')).toBeNull();
    });

    it('shows the hint of who sees the TV, different for the default one', async () => {
      const first = await render(TV, [OWN]);
      expect(first.el.querySelector('.hint')?.textContent).toBe(
        'Só quem estiver marcado vê esta TV.',
      );
      const second = await render(DEFAULT_TV, []);
      expect(second.el.querySelector('.hint')?.textContent).toBe(
        'Quem não está em nenhuma TV vê esta.',
      );
    });
  });

  describe('removing', () => {
    it('asks first, in line, and a "Manter" goes back without a request', async () => {
      const { button, el, settle } = await render(TV, [OWN]);
      button('Remover TV').click();
      await settle();
      expect(el.textContent).toContain('Remover esta TV?');
      button('Manter').click();
      await settle();
      expect(el.textContent).not.toContain('Remover esta TV?');
      expect(api.deleteTv).not.toHaveBeenCalled();
    });

    it('removes after the confirmation and closes saying something changed', async () => {
      const { button, settle, closed } = await render(TV, [OWN]);
      button('Remover TV').click();
      await settle();
      button('Remover').click();
      await settle();
      expect(api.deleteTv).toHaveBeenCalledWith('tv-2');
      expect(closed).toEqual([true]);
    });

    it('has no remove button for the default TV, which the API would refuse', async () => {
      const { el } = await render(DEFAULT_TV, []);
      expect(el.textContent).not.toContain('Remover TV');
    });

    it('has no remove button when creating', async () => {
      const { el } = await render(null, [FREE]);
      expect(el.textContent).not.toContain('Remover TV');
    });

    it('explains a refusal and goes back to the sheet', async () => {
      api.deleteTv.mockRejectedValueOnce(problem(409));
      const { button, settle, error, closed } = await render(TV, [OWN]);
      button('Remover TV').click();
      await settle();
      button('Remover').click();
      await settle();
      expect(error()).toBe('A TV padrão não pode ser removida.');
      expect(closed).toEqual([]);
    });
  });
  describe('TVs na rede ao criar', () => {
    const SALA = {
      id: 'a1b2c3d4e5f60718',
      kind: 'samsung',
      name: 'Samsung Sala',
      controlled: true,
    };

    it('lists the TVs the online computers found first, marked Na Sua Rede, and the other computers after', async () => {
      api.nearbyTvs.mockImplementation(async (slug: string) =>
        slug === 'pc-livre' ? { status: 'ok', items: [SALA] } : { status: 'ok', items: [] },
      );
      const { el } = await render(null, [FREE, OTHER]);
      const legends = Array.from(el.querySelectorAll('legend')).map((l) => l.textContent?.trim());
      expect(legends.indexOf('TVs Encontradas')).toBeGreaterThanOrEqual(0);
      expect(legends.indexOf('TVs Encontradas')).toBeLessThan(
        legends.indexOf('Outros Computadores'),
      );
      const rows = Array.from(el.querySelectorAll<HTMLElement>('label.choice'));
      expect(rows[0].querySelector('.ui-row-title')?.textContent?.trim()).toBe('Samsung Sala');
      expect(rows[0].querySelector('.ui-chip')?.textContent?.trim()).toBe('Na Sua Rede');
      // O computador que achou a TV não se repete na lista de baixo.
      const titles = rows.map((row) => row.querySelector('.ui-row-title')?.textContent?.trim());
      expect(titles).toEqual(['Samsung Sala', 'PC do quarto']);
      // Só computador ligado é perguntado.
      expect(api.nearbyTvs).toHaveBeenCalledTimes(1);
      expect(api.nearbyTvs).toHaveBeenCalledWith('pc-livre');
    });

    it('choosing a found TV picks its computer and uses its name when the name is empty', async () => {
      api.nearbyTvs.mockResolvedValue({ status: 'ok', items: [SALA] });
      const { pick, name, save } = await render(null, [FREE]);
      await pick('Samsung Sala');
      expect(name().value).toBe('Samsung Sala');
      await save();
      expect(api.createTv).toHaveBeenCalledWith('pc-livre', 'Samsung Sala');
    });

    it('keeps the name the person already typed', async () => {
      api.nearbyTvs.mockResolvedValue({ status: 'ok', items: [SALA] });
      const { pick, type, name } = await render(null, [FREE]);
      await type('Quarto');
      await pick('Samsung Sala');
      expect(name().value).toBe('Quarto');
    });

    it('shows no Na Sua Rede block, and keeps the plain list, when nothing was found', async () => {
      const { el } = await render(null, [FREE]);
      const legends = Array.from(el.querySelectorAll('legend')).map((l) => l.textContent?.trim());
      expect(legends).not.toContain('TVs Encontradas');
      expect(legends).toContain('Computador');
    });

    it('does not search when editing a TV', async () => {
      await render(TV, [OWN]);
      expect(api.nearbyTvs).not.toHaveBeenCalled();
    });

    it('a search that fails leaves the computer in the normal list', async () => {
      api.nearbyTvs.mockRejectedValue(problem(500));
      const { el } = await render(null, [FREE]);
      expect(el.textContent).not.toContain('TVs Encontradas');
      expect(el.textContent).toContain('Notebook');
    });
  });

  describe('permissão da TV', () => {
    const NEEDED: TvItem = { ...TV, permissionNeeded: true };

    it('is offered on a Samsung TV and says when the TV asked again', async () => {
      const { el } = await render(NEEDED, [OWN]);
      expect(el.textContent).toContain('Permissão da TV');
      expect(el.textContent).toContain('A TV pediu a permissão do UniOver de novo.');
    });

    it('is not offered on an Android TV', async () => {
      const { el } = await render(DEFAULT_TV, []);
      expect(el.textContent).not.toContain('Permissão da TV');
    });

    it('is not offered when creating', async () => {
      const { el } = await render(null, [FREE]);
      expect(el.textContent).not.toContain('Permissão da TV');
    });

    it('asking again opens the short sheet and, once granted, the list is read again', async () => {
      const { el, button, settle, closed, fixture } = await render(NEEDED, [OWN]);
      button('Pedir Agora').click();
      await settle();
      const sheet = el.querySelector('app-tv-permission-sheet')!;
      expect(sheet).not.toBeNull();
      expect(sheet.textContent).toContain('Na próxima vez que a TV mostrar um pedido do UniOver');
      sheet.querySelectorAll<HTMLButtonElement>('button')[1].click();
      await settle();
      expect(permission.ask).toHaveBeenCalledWith('tv-2');
      await settle();
      expect(sheet.textContent).toContain('A TV já reconhece o UniOver.');
      sheet.querySelectorAll<HTMLButtonElement>('button')[0].click();
      await settle();
      expect(el.querySelector('app-tv-permission-sheet')).toBeNull();
      expect(el.textContent).toContain('A TV reconhece o UniOver.');
      // Algo mudou no servidor: ao sair, a página relê a lista.
      el.querySelector<HTMLButtonElement>('button')?.focus();
      fixture.componentInstance['cancel']();
      await settle();
      expect(closed).toEqual([true]);
    });
  });
});
