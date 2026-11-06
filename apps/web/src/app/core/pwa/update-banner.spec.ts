import { TestBed } from '@angular/core/testing';
import { PwaUpdateService } from './pwa-update.service';
import { UpdateBanner } from './update-banner';

describe('UpdateBanner', () => {
  it('shows the notice and the button only when an update is ready', async () => {
    const service = TestBed.inject(PwaUpdateService);
    const apply = vi.spyOn(service, 'applyUpdate').mockImplementation(() => undefined);
    const fixture = TestBed.createComponent(UpdateBanner);
    const el = fixture.nativeElement as HTMLElement;
    await fixture.whenStable();
    expect(el.querySelector('button')).toBeNull();

    service.updateReady.set(true);
    await fixture.whenStable();
    expect(el.textContent).toContain('Nova versão disponível');
    expect(el.querySelector('.ui-collapse > .ui-collapse-inner > .banner')).not.toBeNull();
    el.querySelector('button')!.click();
    expect(apply).toHaveBeenCalled();
  });

  it('asks before throwing away unsaved work, with an in-app dialog and no window.confirm', async () => {
    const service = TestBed.inject(PwaUpdateService);
    const confirmSpy = vi.spyOn(window, 'confirm');
    const confirmUpdate = vi.spyOn(service, 'confirmUpdate').mockImplementation(() => undefined);
    const fixture = TestBed.createComponent(UpdateBanner);
    const el = fixture.nativeElement as HTMLElement;
    service.updateReady.set(true);
    await fixture.whenStable();
    expect(el.querySelector('[role="alertdialog"]')).toBeNull();

    service.confirmingUpdate.set(true);
    await fixture.whenStable();
    const dialog = el.querySelector('[role="alertdialog"]')!;
    expect(dialog.textContent).toContain('Atualizar agora?');
    expect(dialog.textContent).toContain('não salvo');

    const [keep, go] = Array.from(dialog.querySelectorAll('button'));
    expect(keep.textContent).toContain('Continuar editando');
    keep.click();
    expect(service.confirmingUpdate()).toBe(false);
    expect(confirmUpdate).not.toHaveBeenCalled();

    service.confirmingUpdate.set(true);
    await fixture.whenStable();
    el.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button')[1].click();
    expect(go.textContent).toContain('Atualizar mesmo assim');
    expect(confirmUpdate).toHaveBeenCalledTimes(1);
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  it('closes the dialog on Escape', async () => {
    const service = TestBed.inject(PwaUpdateService);
    const fixture = TestBed.createComponent(UpdateBanner);
    const el = fixture.nativeElement as HTMLElement;
    service.updateReady.set(true);
    service.confirmingUpdate.set(true);
    await fixture.whenStable();
    el.querySelector('[role="alertdialog"]')!.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    );
    expect(service.confirmingUpdate()).toBe(false);
  });

  it('keeps the error hidden until reloading was impossible', async () => {
    const service = TestBed.inject(PwaUpdateService);
    const fixture = TestBed.createComponent(UpdateBanner);
    const el = fixture.nativeElement as HTMLElement;
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
});
