import { TestBed } from '@angular/core/testing';
import { PwaUpdateService } from './pwa-update.service';
import { UpdateBanner } from './update-banner';

describe('UpdateBanner', () => {
  function mount() {
    const service = TestBed.inject(PwaUpdateService);
    const fixture = TestBed.createComponent(UpdateBanner);
    const el = fixture.nativeElement as HTMLElement;
    return { service, fixture, el };
  }

  const key = (target: Element, init: KeyboardEventInit) => {
    const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
    target.dispatchEvent(event);
    return event;
  };

  it('shows the notice and the button only when an update is ready', async () => {
    const { service, fixture, el } = mount();
    const apply = vi.spyOn(service, 'applyUpdate').mockResolvedValue(undefined);
    await fixture.whenStable();
    expect(el.querySelector('button')).toBeNull();

    service.updateReady.set(true);
    await fixture.whenStable();
    expect(el.textContent).toContain('Nova versão disponível');
    expect(el.querySelector('.ui-collapse > .ui-collapse-inner > .banner')).not.toBeNull();
    el.querySelector('button')!.click();
    expect(apply).toHaveBeenCalled();
  });

  it('says why a navigation did nothing, with a button that runs the update confirmation', async () => {
    const { service, fixture, el } = mount();
    const apply = vi.spyOn(service, 'applyUpdate').mockResolvedValue(undefined);
    service.updateReady.set(true);
    service.navigationBlocked.set(true);
    await fixture.whenStable();

    expect(el.textContent).toContain('Há uma versão nova: salve ou descarte para continuar');
    expect(el.textContent).not.toContain('Nova versão disponível');
    el.querySelector('button')!.click();
    expect(apply).toHaveBeenCalledTimes(1);

    service.navigationBlocked.set(false);
    await fixture.whenStable();
    expect(el.textContent).toContain('Nova versão disponível');
  });

  it('keeps the button on "Atualizando…" and disabled while the tap is still deciding', async () => {
    const { service, fixture, el } = mount();
    service.updateReady.set(true);
    service.updateDeciding.set(true);
    await fixture.whenStable();

    const button = el.querySelector<HTMLButtonElement>('.banner button')!;
    expect(button.disabled).toBe(true);
    expect(button.textContent).toContain('Atualizando…');
  });

  it('keeps the error hidden until reloading was impossible', async () => {
    const { service, fixture, el } = mount();
    service.updateReady.set(true);
    service.applyingUpdate.set(true);
    await fixture.whenStable();

    expect(el.querySelector('.error')).toBeNull();
    expect(el.querySelector<HTMLButtonElement>('button')?.disabled).toBe(true);
    expect(el.textContent).toContain('Atualizando…');

    service.applyingUpdate.set(false);
    service.updateError.set(true);
    await fixture.whenStable();
    expect(el.querySelector('.error')?.textContent).toContain(
      'Não foi possível ativar a nova versão',
    );
  });

  describe('the confirmation dialog', () => {
    async function open(kind: 'mine' | 'other-tab' = 'mine') {
      const made = mount();
      made.service.updateReady.set(true);
      await made.fixture.whenStable();
      made.service.confirmingUpdate.set(kind);
      await made.fixture.whenStable();
      const dialog = made.el.querySelector<HTMLElement>('[role="alertdialog"]')!;
      const [keep, go] = Array.from(dialog.querySelectorAll('button'));
      return { ...made, dialog, keep, go };
    }

    it('is an in-app dialog (never window.confirm) that says the unsaved work is on this screen', async () => {
      const confirmSpy = vi.spyOn(window, 'confirm');
      const { dialog, keep, go, service } = await open('mine');
      const confirmUpdate = vi.spyOn(service, 'confirmUpdate').mockResolvedValue(undefined);

      expect(dialog.textContent).toContain('Atualizar agora?');
      expect(dialog.textContent).toContain('nesta tela');
      expect(keep.textContent).toContain('Continuar editando');
      expect(go.textContent).toContain('Atualizar mesmo assim');

      keep.click();
      expect(service.confirmingUpdate()).toBeNull();
      expect(confirmUpdate).not.toHaveBeenCalled();

      go.click();
      expect(confirmUpdate).toHaveBeenCalledTimes(1);
      expect(confirmSpy).not.toHaveBeenCalled();
    });

    it('says another open tab has unsaved work when that is the reason', async () => {
      const { dialog } = await open('other-tab');
      expect(dialog.textContent).toContain('Outra aba aberta tem algo não salvo');
      expect(dialog.textContent).toContain('ela vai precisar salvar e recarregar');
      expect(dialog.textContent).not.toContain('nesta tela');
      expect(dialog.textContent).not.toContain('se perde');
    });

    it('moves the focus into the dialog, onto the safe choice, and gives it back on close', async () => {
      const { service, fixture, el } = mount();
      service.updateReady.set(true);
      await fixture.whenStable();
      const noticeButton = el.querySelector<HTMLButtonElement>('.banner button')!;
      noticeButton.focus();
      expect(document.activeElement).toBe(noticeButton);

      service.confirmingUpdate.set('mine');
      await fixture.whenStable();
      const keep = el.querySelector<HTMLButtonElement>('[role="alertdialog"] button')!;
      expect(document.activeElement).toBe(keep);

      service.cancelUpdate();
      await fixture.whenStable();
      expect(el.querySelector('[role="alertdialog"]')).toBeNull();
      expect(document.activeElement).toBe(noticeButton);
    });

    it('closes on a real Escape key pressed on the focused element', async () => {
      const { service } = await open();
      const focused = document.activeElement!;
      expect(focused.closest('[role="alertdialog"]')).not.toBeNull();

      const event = key(focused, { key: 'Escape' });
      expect(event.defaultPrevented).toBe(true);
      expect(service.confirmingUpdate()).toBeNull();
    });

    it('keeps Tab and Shift+Tab inside the dialog', async () => {
      const { keep, go } = await open();

      go.focus();
      const forward = key(go, { key: 'Tab' });
      expect(forward.defaultPrevented).toBe(true);
      expect(document.activeElement).toBe(keep);

      const backward = key(keep, { key: 'Tab', shiftKey: true });
      expect(backward.defaultPrevented).toBe(true);
      expect(document.activeElement).toBe(go);
    });

    it('lets Tab move between the two buttons normally, and pulls a stray focus back in', async () => {
      const { keep, go, el } = await open();
      const middle = key(keep, { key: 'Tab' });
      expect(middle.defaultPrevented).toBe(false);

      const stray = document.createElement('button');
      document.body.appendChild(stray);
      stray.focus();
      const event = key(el.querySelector('[role="alertdialog"]')!, { key: 'Tab' });
      expect(event.defaultPrevented).toBe(true);
      expect(document.activeElement).toBe(keep);
      stray.remove();
      expect(go).toBeTruthy();
    });
  });
});
