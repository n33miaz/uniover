import { TestBed } from '@angular/core/testing';
import { ConnectivityService } from '../../../core/connectivity/connectivity.service';
import { NEW_ITEM } from '../../../core/offline-queue/queue-test-kit';
import { HttpErrorResponse } from '@angular/common/http';
import { TrainingSync } from '../data/sync/training-sync';
import { setupTraining } from '../data/sync/training-test-kit';
import { eventually, setupScreen } from './screen-test-kit';
import { TrainingSyncLine } from './training-sync-line';

describe('TrainingSyncLine', () => {
  async function render() {
    const kit = await setupScreen();
    const fixture = TestBed.createComponent(TrainingSyncLine);
    await fixture.whenStable();
    fixture.detectChanges();
    return { ...kit, fixture, el: fixture.nativeElement as HTMLElement };
  }

  const text = (el: HTMLElement) => el.textContent?.replace(/\s+/g, ' ').trim() ?? '';

  it('takes no height while it has nothing to say (the first pull has not started)', async () => {
    setupTraining().pause();
    const fixture = TestBed.createComponent(TrainingSyncLine);
    await fixture.whenStable();
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('.line')?.classList.contains('empty')).toBe(true);
  });

  it('says the device is up to date, with the time of the last pull', async () => {
    const { fixture, el } = await render();
    await eventually(fixture, () => expect(text(el)).toMatch(/sincronizado às \d{2}:\d{2}/));
    expect(el.querySelector('button')).toBeNull();
  });

  it('says it keeps going with what is on the device when there is no network', async () => {
    const { fixture, el } = await render();
    TestBed.inject(ConnectivityService).online.set(false);
    await eventually(fixture, () =>
      expect(text(el)).toContain('Sem rede: usando o que está no aparelho'),
    );
    expect(el.querySelector('.line')?.classList.contains('warn')).toBe(true);
  });

  it('says so when the server did not answer the last pull', async () => {
    const { fixture, el, pull } = await render();
    pull.script = [new HttpErrorResponse({ status: 503 })];
    await TestBed.inject(TrainingSync).pullNow();
    await eventually(fixture, () =>
      expect(text(el)).toContain('Sem resposta do servidor: usando o que está no aparelho'),
    );
  });

  it('offers "Sincronizar agora" when there is something waiting to be sent, and uses it', async () => {
    const { fixture, el, queue } = await render();
    await queue().enqueue({ ...NEW_ITEM, url: '/api/v1/training/routines/1' });
    await eventually(fixture, () => expect(text(el)).toContain('1 ainda não sincronizado'));
    const pull = vi.spyOn(TestBed.inject(TrainingSync), 'pullNow').mockResolvedValue();
    const action = el.querySelector<HTMLButtonElement>('.act')!;
    expect(action.textContent?.trim()).toBe('Sincronizar agora');
    action.click();
    expect(pull).toHaveBeenCalledOnce();
  });

  it('does not offer to send while there is no network', async () => {
    const { fixture, el, queue } = await render();
    await queue().enqueue({ ...NEW_ITEM, url: '/api/v1/training/routines/1' });
    TestBed.inject(ConnectivityService).online.set(false);
    await eventually(fixture, () => expect(text(el)).toContain('ainda não sincronizado'));
    expect(el.querySelector('.act')).toBeNull();
  });

  it('shows what the server refused, with a button to see it, and tells the page', async () => {
    const { fixture, el, queue, store } = await render();
    const id = await queue().enqueue({ ...NEW_ITEM, url: '/api/v1/training/routines/1' });
    const stored = (await store().get(id))!;
    await store().markFailed(id, stored.revision, 'http-422');
    const asked = vi.fn();
    fixture.componentInstance.issues.subscribe(asked);
    await eventually(fixture, () => expect(text(el)).toContain('1 com erro'));
    expect(el.querySelector('.line')?.classList.contains('bad')).toBe(true);
    const see = el.querySelector<HTMLButtonElement>('.act')!;
    expect(see.textContent?.trim()).toBe('Ver');
    see.click();
    expect(asked).toHaveBeenCalledOnce();
  });
});
