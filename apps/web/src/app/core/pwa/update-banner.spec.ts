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
