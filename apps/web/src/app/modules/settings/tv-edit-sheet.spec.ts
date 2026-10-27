import { HttpErrorResponse, HttpHeaders } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { AuthApi, GuestSummary } from '../../core/auth/auth-api';
import { AuthService } from '../../core/auth/auth.service';
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
  permissions: ['module:tv'],
});

describe('TvEditSheet', () => {
  const api = {
    createTv: vi.fn(),
    updateTv: vi.fn(),
    deleteTv: vi.fn(),
    tvMembers: vi.fn(),
    setTvMembers: vi.fn(),
  };
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
});
