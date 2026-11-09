import { TestBed } from '@angular/core/testing';
import { PcSlideTimer, formatElapsed } from './slide-timer';

describe('formatElapsed', () => {
  it.each([
    [0, '00:00'],
    [59, '00:59'],
    [61, '01:01'],
    [3599, '59:59'],
    [3600, '1:00:00'],
    [3725.9, '1:02:05'],
    [-5, '00:00'],
  ])('%d s is %s', (seconds, text) => {
    expect(formatElapsed(seconds)).toBe(text);
  });
});

describe('PcSlideTimer', () => {
  let fixture: ReturnType<typeof TestBed.createComponent<PcSlideTimer>>;
  let root: HTMLElement;

  const time = () => root.querySelector('.time')!.textContent?.trim();
  const button = (label: string) =>
    root.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;

  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
    });
    fixture = TestBed.createComponent(PcSlideTimer);
    fixture.detectChanges();
    root = fixture.nativeElement;
  });

  afterEach(() => {
    fixture.destroy();
    vi.useRealTimers();
  });

  it('starts at zero, counts by the clock, pauses and goes on from where it was', async () => {
    expect(time()).toBe('00:00');
    expect(button('Zerar cronômetro').disabled).toBe(true);
    button('Iniciar cronômetro').click();
    await vi.advanceTimersByTimeAsync(5_000);
    fixture.detectChanges();
    expect(time()).toBe('00:05');
    button('Pausar cronômetro').click();
    await vi.advanceTimersByTimeAsync(10_000);
    fixture.detectChanges();
    expect(time()).toBe('00:05');
    button('Iniciar cronômetro').click();
    await vi.advanceTimersByTimeAsync(2_000);
    fixture.detectChanges();
    expect(time()).toBe('00:07');
  });

  it('reset stops it and zeroes it', async () => {
    button('Iniciar cronômetro').click();
    await vi.advanceTimersByTimeAsync(3_000);
    button('Zerar cronômetro').click();
    await vi.advanceTimersByTimeAsync(3_000);
    fixture.detectChanges();
    expect(time()).toBe('00:00');
    expect(button('Iniciar cronômetro')).not.toBeNull();
  });

  it('leaves no timer running when the screen goes away', async () => {
    const elapsed = (fixture.componentInstance as unknown as { elapsed: () => number }).elapsed;
    button('Iniciar cronômetro').click();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(elapsed()).toBe(2);
    fixture.destroy();
    // Sem o fim do intervalo, a conta seguiria subindo atrás da tela que já não existe.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(elapsed()).toBe(2);
  });
});
