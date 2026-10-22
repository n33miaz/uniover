import { HttpErrorResponse, HttpHeaders } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import type { GuestSummary } from '../../core/auth/auth-api';
import { GuestPermissions, PeopleApi } from './people-api';
import { PeoplePermissionsSheet } from './people-permissions-sheet';

const PROBLEM = 'https://uniover.app/problems/';

function problem(
  status: number,
  kind: string,
  extra: Record<string, unknown> = {},
  headers: Record<string, string> = {},
) {
  return new HttpErrorResponse({
    status,
    headers: new HttpHeaders(headers),
    error: { type: PROBLEM + kind, title: 'x', ...extra },
  });
}

const GUEST: GuestSummary = {
  id: 'g1',
  displayName: 'Bia',
  email: 'bia@exemplo.com',
  createdAt: '2026-10-19T15:00:00Z',
  disabledAt: null,
  permissions: ['module:tv', 'tv:control', 'tv:power', 'tv:launch', 'tv:history'],
};

describe('PeoplePermissionsSheet', () => {
  const api = { setPermissions: vi.fn() };

  beforeEach(() => {
    api.setPermissions
      .mockReset()
      .mockImplementation(
        async (id: string, permissions: readonly string[]): Promise<GuestPermissions> => ({
          ...GUEST,
          id,
          permissions: [...permissions],
        }),
      );
    TestBed.configureTestingModule({ providers: [{ provide: PeopleApi, useValue: api }] });
  });

  async function render(guest: GuestSummary = GUEST) {
    const fixture = TestBed.createComponent(PeoplePermissionsSheet);
    fixture.componentRef.setInput('guest', guest);
    const saved: GuestPermissions[] = [];
    let closed = 0;
    let outdated = 0;
    fixture.componentInstance.saved.subscribe((g) => saved.push(g));
    fixture.componentInstance.closed.subscribe(() => closed++);
    fixture.componentInstance.outdated.subscribe(() => outdated++);
    await fixture.whenStable();
    const el = fixture.nativeElement as HTMLElement;
    const buttons = () => Array.from(el.querySelectorAll<HTMLButtonElement>('.footer button'));
    const button = (text: string) => buttons().find((b) => b.textContent?.trim() === text)!;
    const option = (text: string) =>
      Array.from(el.querySelectorAll<HTMLElement>('label.option'))
        .find((row) => row.querySelector('.option-title')?.textContent?.trim() === text)!
        .querySelector<HTMLInputElement>('input')!;
    const flip = async (text: string) => {
      option(text).click();
      await fixture.whenStable();
    };
    const save = async () => {
      el.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
      await fixture.whenStable();
    };
    const error = () => el.querySelector('.error')?.textContent?.replace(/\s+/g, ' ').trim();
    return {
      fixture,
      el,
      buttons,
      button,
      option,
      flip,
      save,
      error,
      saved,
      closed: () => closed,
      outdated: () => outdated,
    };
  }

  it('opens as a modal sheet for that person, with no close button, saying when a change takes effect', async () => {
    const { el, buttons } = await render();
    const dialog = el.querySelector('dialog')!;
    expect(dialog.hasAttribute('open')).toBe(true);
    expect(dialog.getAttribute('aria-labelledby')).toBe('people-sheet-title');
    expect(el.querySelector('#people-sheet-title')?.textContent).toBe('Permissões de Bia');
    expect(el.querySelector('#people-sheet-hint')?.textContent).toContain('até 30 segundos');
    expect(buttons().map((b) => b.textContent?.trim())).toEqual(['Cancelar', 'Salvar']);
  });

  it('pins the one-line summary in the footer, which follows the switches, instead of at the end of a long list', async () => {
    const { el, flip, fixture } = await render();
    expect(el.querySelector('app-people-permission-picker .summary')).toBeNull();
    const summary = () =>
      el.querySelector('.footer .summary')?.textContent?.replace(/\s+/g, ' ').trim();
    expect(summary()).toBe('Poderá: Controlar a TV · Desligar a TV · Abrir apps · Ver o histórico');
    await flip('Desligar a TV');
    await fixture.whenStable();
    expect(summary()).toBe('Poderá: Controlar a TV · Abrir apps · Ver o histórico');
  });

  it('opens with the focus on the title, so the first Tab lands on the first control and no model looks pressed', async () => {
    const { el } = await render();
    const title = el.querySelector('#people-sheet-title')!;
    expect(title.hasAttribute('autofocus')).toBe(true);
    expect(title.getAttribute('tabindex')).toBe('-1');
  });

  it('opens with the switches marked for what the person has today', async () => {
    const { option } = await render();
    expect(option('Ver a TV').checked).toBe(true);
    expect(option('Desligar a TV').checked).toBe(true);
    expect(option('Editar e reordenar atalhos').checked).toBe(false);
    expect(option('Usar o Treino').checked).toBe(false);
  });

  it('only lets save when something changed, and never sends an unchanged list', async () => {
    const { button, flip, save } = await render();
    expect(button('Salvar').disabled).toBe(true);
    await save();
    expect(api.setPermissions).not.toHaveBeenCalled();

    await flip('Editar e reordenar atalhos');
    expect(button('Salvar').disabled).toBe(false);
    // Desfazer a mudança devolve o botão ao estado de nada a salvar.
    await flip('Editar e reordenar atalhos');
    expect(button('Salvar').disabled).toBe(true);
  });

  it('sends the whole list, in the catalog order, and hands the page the guest the API returned', async () => {
    const { flip, save, saved, closed } = await render();
    await flip('Editar e reordenar atalhos');
    await flip('Usar o Treino');
    await save();
    expect(api.setPermissions).toHaveBeenCalledTimes(1);
    expect(api.setPermissions).toHaveBeenCalledWith('g1', [
      'module:tv',
      'tv:control',
      'tv:power',
      'tv:launch',
      'tv:edit-shortcuts',
      'tv:history',
      'module:training',
    ]);
    await vi.waitFor(() => expect(saved).toHaveLength(1));
    expect(saved[0].permissions).toContain('module:training');
    expect(closed()).toBe(0);
  });

  it('turning "see the TV" off sends only what is left, so a TV action never travels alone', async () => {
    const { flip, save } = await render({
      ...GUEST,
      permissions: [...GUEST.permissions, 'module:training'],
    });
    await flip('Ver a TV');
    await save();
    expect(api.setPermissions).toHaveBeenCalledWith('g1', ['module:training']);
  });

  it('keeps a permission the screen cannot name when it saves another change', async () => {
    const { flip, save } = await render({
      ...GUEST,
      permissions: [...GUEST.permissions, 'module:audit'],
    });
    await flip('Usar o Treino');
    await save();
    expect(api.setPermissions).toHaveBeenCalledWith('g1', [
      'module:tv',
      'tv:control',
      'tv:power',
      'tv:launch',
      'tv:history',
      'module:training',
      'module:audit',
    ]);
  });

  it('does not let save with no module on, and says why', async () => {
    const { el, flip, button, save } = await render({ ...GUEST, permissions: ['module:training'] });
    await flip('Usar o Treino');
    expect(button('Salvar').disabled).toBe(true);
    expect(el.querySelector('.summary')?.textContent).toContain('Ligue ao menos a TV ou o Treino');
    await save();
    expect(api.setPermissions).not.toHaveBeenCalled();
  });

  it('shows the saving state and keeps both buttons off until the answer arrives', async () => {
    let finish!: (guest: GuestPermissions) => void;
    api.setPermissions.mockReturnValue(
      new Promise<GuestPermissions>((resolve) => (finish = resolve)),
    );
    const { fixture, el, button, flip, save, saved } = await render();
    await flip('Usar o Treino');
    void save();
    // O estado "Salvando…" aparece depois da cadeia assíncrona do salvamento: esperar o estado, e não só a estabilidade
    // do momento, senão a ordem das tarefas num executor sobrecarregado decide o resultado.
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(el.textContent).toContain('Salvando…');
    });
    expect(button('Salvar').disabled).toBe(true);
    expect(button('Cancelar').disabled).toBe(true);
    finish({ ...GUEST, permissions: ['module:tv', 'module:training'] });
    await vi.waitFor(() => expect(saved).toHaveLength(1));
    expect(el.textContent).not.toContain('Salvando…');
  });

  it('cancelling asks nothing of the API and tells the page to close', async () => {
    const { button, fixture, closed } = await render();
    button('Cancelar').click();
    await fixture.whenStable();
    expect(closed()).toBe(1);
    expect(api.setPermissions).not.toHaveBeenCalled();
  });

  describe('errors, one explanation for each kind', () => {
    async function fail(rejection: unknown) {
      api.setPermissions.mockRejectedValue(rejection);
      const sheet = await render();
      await sheet.flip('Usar o Treino');
      await sheet.save();
      await vi.waitFor(() => expect(sheet.error()).toBeTruthy());
      return sheet;
    }

    it('403 for the passkey: says it was not confirmed and nothing changed, and allows another try', async () => {
      const { error, button, saved } = await fail(
        problem(403, 'step-up-required', { code: 'step_up_required' }),
      );
      expect(error()).toContain('não foi confirmada com a passkey');
      expect(error()).toContain('Nada foi alterado');
      expect(button('Salvar').disabled).toBe(false);
      expect(saved).toHaveLength(0);
    });

    it('any other 403: only an administrator changes permissions', async () => {
      const { error } = await fail(problem(403, 'forbidden'));
      expect(error()).toContain('Só um administrador');
    });

    it('404: the person is gone, the list is stale, and there is nothing left to save', async () => {
      const { error, button, outdated } = await fail(new HttpErrorResponse({ status: 404 }));
      expect(error()).toContain('não está mais na lista');
      expect(outdated()).toBe(1);
      expect(button('Salvar').disabled).toBe(true);
      expect(button('Fechar')).toBeTruthy();
    });

    it('409 for a revoked guest: explains the access is gone and refreshes the list', async () => {
      const { error, button, outdated } = await fail(problem(409, 'guest-revoked'));
      expect(error()).toContain('já foi revogado');
      expect(outdated()).toBe(1);
      expect(button('Salvar').disabled).toBe(true);
    });

    it('409 for two edits at once: asks to check and save again, without closing the door', async () => {
      const { error, button, outdated } = await fail(problem(409, 'permissions-conflict'));
      expect(error()).toContain('Outra mudança aconteceu ao mesmo tempo');
      expect(outdated()).toBe(0);
      expect(button('Salvar').disabled).toBe(false);
    });

    it('400: the combination was not accepted', async () => {
      const { error } = await fail(
        problem(400, 'validation-failed', { errors: { permissions: ['A lista é inválida.'] } }),
      );
      expect(error()).toContain('combinação de permissões não foi aceita');
    });

    it('429: asks to wait, with the seconds when the server says them', async () => {
      expect(
        (await fail(problem(429, 'rate-limited', {}, { 'Retry-After': '12' }))).error(),
      ).toContain('Tente de novo em 12 s');
    });

    it('no connection: says nothing changed and to try again', async () => {
      const { error } = await fail(new HttpErrorResponse({ status: 0 }));
      expect(error()).toContain('Sem conexão com o servidor');
      expect(error()).toContain('Nada foi alterado');
    });

    it('anything else: a general sentence, never the technical text of the server', async () => {
      const { error } = await fail(problem(500, 'boom'));
      expect(error()).toContain('Não foi possível salvar agora');
      expect(error()).not.toContain('boom');
    });

    it('a new try clears the old error', async () => {
      api.setPermissions.mockRejectedValueOnce(problem(500, 'boom'));
      const { fixture, flip, save, error, saved } = await render();
      await flip('Usar o Treino');
      await save();
      await vi.waitFor(() => expect(error()).toBeTruthy());
      await save();
      await vi.waitFor(() => expect(saved).toHaveLength(1));
      await fixture.whenStable();
      expect(error()).toBeUndefined();
    });
  });
});
