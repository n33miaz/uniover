import { TestBed } from '@angular/core/testing';
import { ClockService } from './clock.service';

describe('ClockService', () => {
  afterEach(() => vi.useRealTimers());

  it('refreshes the time every 30 seconds', () => {
    vi.useFakeTimers({ now: new Date('2026-10-18T08:00:00') });
    const clock = TestBed.inject(ClockService);
    expect(clock.now().getHours()).toBe(8);
    vi.setSystemTime(new Date('2026-10-18T08:05:00'));
    vi.advanceTimersByTime(30_000);
    expect(clock.now().getMinutes()).toBe(5);
  });
});
