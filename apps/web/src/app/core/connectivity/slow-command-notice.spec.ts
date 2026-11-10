import { TestBed } from '@angular/core/testing';
import { ClientTelemetry } from '../telemetry/client-telemetry';
import { SlowCommandNotice } from './slow-command-notice';
import { SlowCommandWatch } from './slow-command';

describe('SlowCommandNotice', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    TestBed.configureTestingModule({
      providers: [{ provide: ClientTelemetry, useValue: { record: vi.fn() } }],
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function render(module: 'tv' | 'pc' | 'training', inline = false) {
    const fixture = TestBed.createComponent(SlowCommandNotice);
    fixture.componentRef.setInput('module', module);
    fixture.componentRef.setInput('inline', inline);
    fixture.detectChanges();
    return fixture;
  }

  it('is silent while nothing is slow', () => {
    const fixture = render('tv');
    expect((fixture.nativeElement as HTMLElement).querySelector('.slow')).toBeNull();
  });

  it('says honestly that the TV is not answering, in a status region, and clears when it answers', async () => {
    const watch = TestBed.inject(SlowCommandWatch);
    const fixture = render('tv');
    const done = watch.begin('tv');
    await vi.advanceTimersByTimeAsync(3_100);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('.slow')?.getAttribute('role')).toBe('status');
    expect(el.textContent).toContain('A TV não está respondendo.');
    done();
    expect(watch.isSlow('tv')).toBe(false);
  });

  it('has its own text for the PC and for the server, and ignores the other modules', async () => {
    const watch = TestBed.inject(SlowCommandWatch);
    const pc = render('pc');
    const training = render('training', true);
    watch.begin('pc');
    await vi.advanceTimersByTimeAsync(3_100);
    pc.detectChanges();
    training.detectChanges();
    expect((pc.nativeElement as HTMLElement).textContent).toContain('O PC não está respondendo.');
    expect((training.nativeElement as HTMLElement).querySelector('.slow')).toBeNull();
    watch.begin('training');
    await vi.advanceTimersByTimeAsync(3_100);
    training.detectChanges();
    const slow = (training.nativeElement as HTMLElement).querySelector('.slow');
    expect(slow?.textContent).toContain('O servidor não está respondendo.');
    expect(slow?.classList.contains('inline')).toBe(true);
  });
});
