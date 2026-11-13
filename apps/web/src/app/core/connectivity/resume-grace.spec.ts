import { TestBed } from '@angular/core/testing';
import { RESUME_GRACE_CONFIG, ResumeGrace } from './resume-grace';

function setVisibility(state: 'visible' | 'hidden') {
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue(state);
  document.dispatchEvent(new Event('visibilitychange'));
}

describe('ResumeGrace', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('is not active on first load: that is not a return', () => {
    expect(TestBed.inject(ResumeGrace).active()).toBe(false);
  });

  it('opens when the page becomes visible again after being hidden, and closes after the configured time', async () => {
    const grace = TestBed.inject(ResumeGrace);
    setVisibility('hidden');
    expect(grace.active()).toBe(false);
    setVisibility('visible');
    expect(grace.active()).toBe(true);
    await vi.advanceTimersByTimeAsync(3_900);
    expect(grace.active()).toBe(true);
    await vi.advanceTimersByTimeAsync(200);
    expect(grace.active()).toBe(false);
  });

  it('a "visible" event without having been hidden does not open it', () => {
    const grace = TestBed.inject(ResumeGrace);
    setVisibility('visible');
    expect(grace.active()).toBe(false);
  });

  it('opens on a page restored from the back-forward cache, and not on a normal show', () => {
    const grace = TestBed.inject(ResumeGrace);
    const plain = new Event('pageshow') as PageTransitionEvent;
    Object.defineProperty(plain, 'persisted', { value: false });
    window.dispatchEvent(plain);
    expect(grace.active()).toBe(false);
    const restored = new Event('pageshow') as PageTransitionEvent;
    Object.defineProperty(restored, 'persisted', { value: true });
    window.dispatchEvent(restored);
    expect(grace.active()).toBe(true);
  });

  it('a return announced by both "visible" and a restored page is one return, in either order', () => {
    const grace = TestBed.inject(ResumeGrace);
    const begins: string[] = [];
    grace.subscribe((event) => {
      if (event === 'begin') begins.push(event);
    });
    const restored = () => {
      const event = new Event('pageshow') as PageTransitionEvent;
      Object.defineProperty(event, 'persisted', { value: true });
      window.dispatchEvent(event);
    };

    setVisibility('hidden');
    setVisibility('visible');
    restored();
    expect(begins).toHaveLength(1);

    // A volta seguinte (a página ficou oculta de novo) conta, com o aviso de restauração vindo primeiro desta vez.
    setVisibility('hidden');
    restored();
    setVisibility('visible');
    expect(begins).toHaveLength(2);
  });

  it('a new return while it is open starts the time again', async () => {
    const grace = TestBed.inject(ResumeGrace);
    grace.begin();
    await vi.advanceTimersByTimeAsync(3_000);
    grace.begin();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(grace.active()).toBe(true);
    await vi.advanceTimersByTimeAsync(1_100);
    expect(grace.active()).toBe(false);
  });

  it('uses the configured time', async () => {
    TestBed.configureTestingModule({
      providers: [{ provide: RESUME_GRACE_CONFIG, useValue: { graceMs: 500 } }],
    });
    const grace = TestBed.inject(ResumeGrace);
    grace.begin();
    await vi.advanceTimersByTimeAsync(600);
    expect(grace.active()).toBe(false);
  });

  it('tells the listeners when it begins and ends, and the unsubscribe works', async () => {
    const grace = TestBed.inject(ResumeGrace);
    const events: string[] = [];
    const off = grace.subscribe((event) => events.push(event));
    grace.begin();
    await vi.advanceTimersByTimeAsync(4_100);
    off();
    grace.begin();
    expect(events).toEqual(['begin', 'end']);
  });

  it('afterEnd runs at once outside the grace period and at its end inside it', async () => {
    const grace = TestBed.inject(ResumeGrace);
    const now = vi.fn();
    grace.afterEnd(now);
    expect(now).toHaveBeenCalledTimes(1);

    grace.begin();
    const later = vi.fn();
    grace.afterEnd(later);
    expect(later).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(4_100);
    expect(later).toHaveBeenCalledTimes(1);
  });

  it('afterEnd can be cancelled', async () => {
    const grace = TestBed.inject(ResumeGrace);
    grace.begin();
    const action = vi.fn();
    grace.afterEnd(action)();
    await vi.advanceTimersByTimeAsync(4_100);
    expect(action).not.toHaveBeenCalled();
  });
});
