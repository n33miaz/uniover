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
    el.querySelector('button')!.click();
    expect(apply).toHaveBeenCalled();
  });
});
