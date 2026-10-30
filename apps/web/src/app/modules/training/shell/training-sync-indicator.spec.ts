import { TestBed } from '@angular/core/testing';
import { ConnectivityService } from '../../../core/connectivity/connectivity.service';
import { vi } from 'vitest';
import { NEW_ITEM } from '../../../core/offline-queue/queue-test-kit';
import { TrainingSync } from '../data/sync/training-sync';
import { eventually, setupScreen } from './screen-test-kit';
import { SYNC_OK_LINGER_MS, TrainingSyncIndicator } from './training-sync-indicator';

describe('TrainingSyncIndicator', () => {
  afterEach(() => vi.useRealTimers());

  async function make() {
    const kit = await setupScreen([], [TrainingSyncIndicator]);
    const indicator = TestBed.inject(TrainingSyncIndicator);
    return { ...kit, indicator };
  }

  it('is hidden while everything is in sync from the start', async () => {
    const { indicator } = await make();
    expect(indicator.state()).toBe('ok');
    expect(indicator.visible()).toBe(false);
  });

  it('reports offline without an error, then pending, and never needs a manual sync', async () => {
    const { indicator } = await make();
    TestBed.inject(ConnectivityService).online.set(false);
    expect(indicator.state()).toBe('offline');
    expect(indicator.visible()).toBe(true);
  });

  it('shows the green ring for a few seconds after getting in sync, then hides it', async () => {
    const { indicator } = await make();
    const online = TestBed.inject(ConnectivityService).online;
    online.set(false);
    TestBed.tick();
    expect(indicator.visible()).toBe(true);
    vi.useFakeTimers();
    online.set(true);
    TestBed.tick();
    expect(indicator.state()).toBe('ok');
    expect(indicator.visible()).toBe(true);
    vi.advanceTimersByTime(SYNC_OK_LINGER_MS - 100);
    expect(indicator.visible()).toBe(true);
    vi.advanceTimersByTime(200);
    expect(indicator.visible()).toBe(false);
  });

  it('keeps the ring while its sheet is open even when in sync', async () => {
    const { indicator } = await make();
    indicator.sheetOpen.set(true);
    expect(indicator.visible()).toBe(true);
    indicator.sheetOpen.set(false);
    expect(indicator.visible()).toBe(false);
  });

  it('maps the waiting, refused and unreachable-server cases to pending and failed, with the count that matters', async () => {
    const { indicator, queue, store } = await make();
    const id = await queue().enqueue({ ...NEW_ITEM, url: '/api/v1/training/routines/1' });
    await eventually({ detectChanges: () => TestBed.tick() }, () =>
      expect(indicator.state()).toBe('pending'),
    );
    expect(indicator.count()).toBe(1);
    await store().markFailed(id, (await store().get(id))!.revision, 'http-422');
    await eventually({ detectChanges: () => TestBed.tick() }, () =>
      expect(indicator.state()).toBe('failed'),
    );
    expect(indicator.count()).toBe(1);
    expect(indicator.visible()).toBe(true);
  });

  it('retries a refused change by queuing it again, sending and pulling, and ignores a second tap meanwhile', async () => {
    const { indicator, queue, store } = await make();
    const pull = vi.spyOn(TestBed.inject(TrainingSync), 'pullNow').mockResolvedValue();
    const id = await queue().enqueue({ ...NEW_ITEM, url: '/api/v1/training/routines/1' });
    await store().markFailed(id, (await store().get(id))!.revision, 'http-422');
    await eventually({ detectChanges: () => TestBed.tick() }, () =>
      expect(indicator.state()).toBe('failed'),
    );
    const retry = vi.spyOn(queue(), 'retry');
    const first = indicator.retry();
    expect(indicator.retrying()).toBe(true);
    await indicator.retry();
    await first;
    expect(retry).toHaveBeenCalledOnce();
    expect(retry).toHaveBeenCalledWith(id);
    expect(pull).toHaveBeenCalledOnce();
    expect(indicator.retrying()).toBe(false);
    expect((await store().get(id))?.status).not.toBe('failed');
  });
});
