import { TestBed } from '@angular/core/testing';
import { setupSessions } from '../sessions/session-data-test-kit';
import { REST_TICK_MS } from './rest-timer.service';

let visibility: 'visible' | 'hidden' = 'visible';

function setVisibility(state: 'visible' | 'hidden') {
  visibility = state;
  document.dispatchEvent(new Event('visibilitychange'));
}

describe('RestTimerService', () => {
  beforeEach(() => {
    visibility = 'visible';
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => visibility,
    });
  });

  afterEach(() => {
    delete (document as unknown as Record<string, unknown>)['visibilityState'];
  });

  it('keeps the end instant, never a counter, and saves it on the device', async () => {
    const t = setupSessions();
    const timer = t.timer();
    const startedAt = t.runtime.now();

    await timer.start(90);

    expect(timer.endsAt()).toBe(startedAt + 90_000);
    expect(timer.active()).toBe(true);
    expect(timer.remaining()).toBe(90_000);
    expect(timer.over()).toBe(false);
    expect((await t.trainingDb.meta.get('restEndsAt'))?.value).toBe(startedAt + 90_000);
  });

  it('ticks once a second while the rest runs and the page is visible, and the signal follows the clock', async () => {
    const t = setupSessions();
    const timer = t.timer();
    await timer.start(90);
    expect(t.runtime.activeTimers).toBe(1);

    t.runtime.advance(REST_TICK_MS * 3);

    expect(timer.remaining()).toBe(87_000);
  });

  it('has no interval at all without a timer', async () => {
    const t = setupSessions();
    const timer = t.timer();

    expect(t.runtime.activeTimers).toBe(0);
    await timer.start(30);
    await timer.skip();

    expect(t.runtime.activeTimers).toBe(0);
    expect(timer.active()).toBe(false);
    expect(timer.endsAt()).toBeNull();
    expect(await t.trainingDb.meta.get('restEndsAt')).toBeUndefined();
  });

  it('has no interval while the page is hidden, and starting a rest hidden does not create one', async () => {
    const t = setupSessions();
    const timer = t.timer();
    await timer.start(90);

    setVisibility('hidden');
    expect(t.runtime.activeTimers).toBe(0);

    await timer.start(60);
    expect(t.runtime.activeTimers).toBe(0);
  });

  it('after 10 minutes "locked" it recalculates from the clock on return: over, no alert, no interval', async () => {
    const t = setupSessions();
    const timer = t.timer();
    await timer.start(90);

    setVisibility('hidden');
    // A tela bloqueada suspende o JavaScript: o relógio anda e nada dispara.
    t.runtime.advance(600_000);
    expect(t.alert.fired).toBe(0);

    setVisibility('visible');

    expect(timer.over()).toBe(true);
    expect(timer.remaining()).toBe(0);
    expect(t.alert.fired).toBe(0);
    expect(t.runtime.activeTimers).toBe(0);
  });

  it('returning before the end shows the time that is left and ticks again', async () => {
    const t = setupSessions();
    const timer = t.timer();
    await timer.start(90);
    setVisibility('hidden');
    t.runtime.advance(30_000);

    setVisibility('visible');

    expect(timer.remaining()).toBe(60_000);
    expect(t.runtime.activeTimers).toBe(1);
    t.runtime.advance(60_000);
    expect(timer.over()).toBe(true);
    expect(t.alert.fired).toBe(1);
  });

  it('warns once when it reaches zero with the page visible, then stops ticking', async () => {
    const t = setupSessions();
    const timer = t.timer();
    await timer.start(5);

    t.runtime.advance(4_000);
    expect(t.alert.fired).toBe(0);
    t.runtime.advance(1_000);

    expect(t.alert.fired).toBe(1);
    expect(timer.over()).toBe(true);
    expect(t.runtime.activeTimers).toBe(0);
    t.runtime.advance(10_000);
    expect(t.alert.fired).toBe(1);
  });

  it('adds 15 seconds to a running rest and the new end is saved', async () => {
    const t = setupSessions();
    const timer = t.timer();
    const now = t.runtime.now();
    await timer.start(30);

    t.runtime.advance(10_000);
    await timer.add();

    expect(timer.endsAt()).toBe(now + 45_000);
    expect(timer.remaining()).toBe(35_000);
    expect((await t.trainingDb.meta.get('restEndsAt'))?.value).toBe(now + 45_000);
  });

  it('adding to a rest that already ended counts from now and ticks again', async () => {
    const t = setupSessions();
    const timer = t.timer();
    await timer.start(5);
    t.runtime.advance(8_000);
    expect(timer.over()).toBe(true);

    await timer.add();

    expect(timer.over()).toBe(false);
    expect(timer.remaining()).toBe(15_000);
    expect(t.runtime.activeTimers).toBe(1);
  });

  it('does nothing when asked to add without a timer', async () => {
    const t = setupSessions();
    const timer = t.timer();

    await timer.add();

    expect(timer.active()).toBe(false);
    expect(await t.trainingDb.meta.get('restEndsAt')).toBeUndefined();
  });

  it('survives a reload: the new service reads the end instant from the device', async () => {
    const t = setupSessions();
    await t.timer().start(90);
    t.runtime.advance(20_000);

    TestBed.resetTestingModule();
    const reopened = setupSessions(t.trainingDb);
    const timer = reopened.timer();
    expect(timer.active()).toBe(false);
    await timer.restore();

    expect(timer.active()).toBe(true);
    expect(timer.remaining()).toBe(90_000);
    expect(reopened.runtime.activeTimers).toBe(1);
  });

  it('restores a rest that ended while the app was closed as over, with no alert and no interval', async () => {
    const t = setupSessions();
    await t.trainingDb.meta.put({ key: 'restEndsAt', value: t.runtime.now() - 5_000 });
    const timer = t.timer();

    await timer.restore();

    expect(timer.active()).toBe(true);
    expect(timer.over()).toBe(true);
    expect(t.alert.fired).toBe(0);
    expect(t.runtime.activeTimers).toBe(0);
  });

  it('restores nothing when there is no saved rest', async () => {
    const t = setupSessions();
    const timer = t.timer();

    await timer.restore();

    expect(timer.active()).toBe(false);
  });

  it('hands the audio unlock to the alert', () => {
    const t = setupSessions();

    t.timer().unlockAudio();

    expect(t.alert.unlockCalls).toBe(1);
  });

  it('stops its interval when it is destroyed', async () => {
    const t = setupSessions();
    await t.timer().start(90);
    expect(t.runtime.activeTimers).toBe(1);

    TestBed.resetTestingModule();

    expect(t.runtime.activeTimers).toBe(0);
  });
});
