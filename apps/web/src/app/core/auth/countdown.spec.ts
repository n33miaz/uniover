import { TestBed } from '@angular/core/testing';
import { createCountdown, describeWait, formatCountdown } from './countdown';

describe('formatCountdown', () => {
  it.each([
    [0, '0:00'],
    [1, '0:01'],
    [42, '0:42'],
    [60, '1:00'],
    [125, '2:05'],
    [3599, '59:59'],
    [3723, '1:02:03'],
    [41.2, '0:42'], // arredonda para cima: nunca mostra 0:00 com tempo sobrando
    [-5, '0:00'],
  ])('%d s reads %s', (seconds, text) => expect(formatCountdown(seconds)).toBe(text));
});

describe('describeWait', () => {
  it.each([
    [1, '1 segundo'],
    [42, '42 segundos'],
    [59.1, '1 minuto'],
    [60, '1 minuto'],
    [125, '3 minutos'],
    [3600, '1 hora'],
    [7300, '3 horas'],
    [0, '1 segundo'],
  ])('%d s is said as %s', (seconds, words) => expect(describeWait(seconds)).toBe(words));
});

describe('createCountdown', () => {
  const make = () => TestBed.runInInjectionContext(() => createCountdown());

  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('counts down from a deadline and stops at zero', () => {
    const countdown = make();
    countdown.start(3);
    expect(countdown.remaining()).toBe(3);
    vi.advanceTimersByTime(1_000);
    expect(countdown.remaining()).toBe(2);
    vi.advanceTimersByTime(2_000);
    expect(countdown.remaining()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not drift when timers are paused (page in the background): it recomputes from the clock on return', () => {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    const countdown = make();
    countdown.start(60);
    // O navegador do celular parou os temporizadores por 45 s: o relógio andou, a contagem não.
    vi.setSystemTime(Date.now() + 45_000);
    expect(countdown.remaining()).toBe(60);
    document.dispatchEvent(new Event('visibilitychange'));
    expect(countdown.remaining()).toBe(15);
  });

  it('restarts and stops on demand, and a zero wait does not run', () => {
    const countdown = make();
    countdown.start(10);
    vi.advanceTimersByTime(3_000);
    countdown.start(5);
    expect(countdown.remaining()).toBe(5);
    countdown.stop();
    expect(countdown.remaining()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    countdown.start(0);
    expect(countdown.remaining()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
