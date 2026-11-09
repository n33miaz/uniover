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

  it('keeps counting when the screen goes away and comes back (a mode or tab change)', async () => {
    button('Iniciar cronômetro').click();
    await vi.advanceTimersByTimeAsync(4_000);
    fixture.destroy();
    await vi.advanceTimersByTimeAsync(3_000);
    const again = TestBed.createComponent(PcSlideTimer);
    again.detectChanges();
    root = again.nativeElement;
    expect(time()).toBe('00:07');
    expect(button('Pausar cronômetro')).not.toBeNull();
    await vi.advanceTimersByTimeAsync(2_000);
    again.detectChanges();
    expect(time()).toBe('00:09');
    // Pausado, o tempo também fica guardado.
    button('Pausar cronômetro').click();
    again.destroy();
    await vi.advanceTimersByTimeAsync(5_000);
    const third = TestBed.createComponent(PcSlideTimer);
    third.detectChanges();
    root = third.nativeElement;
    expect(time()).toBe('00:09');
    expect(button('Iniciar cronômetro')).not.toBeNull();
    third.destroy();
  });

  it('the time is the content of the timer and the name is a label that points at it, so the time is read', () => {
    const timer = root.querySelector('[role="timer"]')!;
    expect(timer.hasAttribute('aria-label')).toBe(false);
    expect(timer.textContent?.trim()).toBe('00:00');
    const label = root.querySelector(`#${timer.getAttribute('aria-labelledby')}`);
    expect(label?.textContent?.trim()).toBe('Cronômetro');
    // Região do tipo `timer` já é "desligada" para anúncio automático: nenhum `aria-live` a ligou.
    expect(timer.getAttribute('aria-live')).not.toBe('polite');
    expect(timer.getAttribute('aria-live')).not.toBe('assertive');
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
