import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';
import { ConnectivityService } from '../../../core/connectivity/connectivity.service';
import { NEW_ITEM } from '../../../core/offline-queue/queue-test-kit';
import { TrainingSync } from '../data/sync/training-sync';
import { eventually, setupScreen } from './screen-test-kit';
import { TrainingSyncIndicator } from './training-sync-indicator';
import { TrainingSyncSheet } from './training-sync-sheet';

describe('TrainingSyncSheet', () => {
  async function render() {
    const kit = await setupScreen([], [TrainingSyncIndicator]);
    const fixture = TestBed.createComponent(TrainingSyncSheet);
    await fixture.whenStable();
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    const text = () => el.textContent?.replace(/\s+/g, ' ').trim() ?? '';
    const action = (label: string) =>
      Array.from(el.querySelectorAll<HTMLButtonElement>('button')).find((button) =>
        button.textContent?.includes(label),
      );
    return { ...kit, fixture, el, text, action };
  }

  it('says everything is in sync and offers nothing to do', async () => {
    const { fixture, text, action } = await render();
    await eventually(fixture, () => expect(text()).toContain('Tudo sincronizado.'));
    expect(action('Tentar de Novo')).toBeUndefined();
    expect(action('Ver os Recusados')).toBeUndefined();
  });

  it('says it keeps using what is on the device without a network, with no retry', async () => {
    const { fixture, text, action } = await render();
    TestBed.inject(ConnectivityService).online.set(false);
    await eventually(fixture, () =>
      expect(text()).toContain('Sem rede: usando o que está no aparelho.'),
    );
    expect(action('Tentar de Novo')).toBeUndefined();
  });

  it('says what waits to be sent, and still has no button: the sending is automatic', async () => {
    const { fixture, queue, text, action } = await render();
    await queue().enqueue({ ...NEW_ITEM, url: '/api/v1/training/routines/1' });
    await eventually(fixture, () => expect(text()).toContain('Aguardando envio.'));
    expect(text()).toContain('1 ainda não sincronizado');
    expect(action('Tentar de Novo')).toBeUndefined();
  });

  it('offers "Tentar de Novo" and "Ver os Recusados" only for a refused change, and opening the sheet does not retry', async () => {
    const { fixture, queue, store, text, action } = await render();
    const pull = vi.spyOn(TestBed.inject(TrainingSync), 'pullNow').mockResolvedValue();
    const id = await queue().enqueue({ ...NEW_ITEM, url: '/api/v1/training/routines/1' });
    await store().markFailed(id, (await store().get(id))!.revision, 'http-422');
    await eventually(fixture, () => expect(text()).toContain('O servidor recusou alterações.'));
    expect(pull).not.toHaveBeenCalled();
    expect(action('Tentar de Novo')).toBeDefined();
    const issues = vi.fn();
    fixture.componentInstance.issues.subscribe(issues);
    action('Ver os Recusados')!.click();
    expect(issues).toHaveBeenCalledOnce();
  });

  it('"Tentar de Novo" puts the refused change back on the queue before sending and pulling', async () => {
    const { fixture, queue, store, action } = await render();
    const pull = vi.spyOn(TestBed.inject(TrainingSync), 'pullNow').mockResolvedValue();
    const id = await queue().enqueue({ ...NEW_ITEM, url: '/api/v1/training/routines/1' });
    await store().markFailed(id, (await store().get(id))!.revision, 'http-422');
    await eventually(fixture, () => expect(action('Tentar de Novo')).toBeDefined());
    const retry = vi.spyOn(queue(), 'retry');
    action('Tentar de Novo')!.click();
    await eventually(fixture, () => expect(pull).toHaveBeenCalledOnce());
    expect(retry).toHaveBeenCalledWith(id);
    expect((await store().get(id))?.status).not.toBe('failed');
  });
});
