import { TestBed } from '@angular/core/testing';
import { PrefersReducedMotion } from './prefers-reduced-motion';

type Listener = (event: MediaQueryListEvent) => void;

function mockMatchMedia(matches: boolean) {
  const listeners = new Set<Listener>();
  const query = vi.fn().mockReturnValue({
    matches,
    addEventListener: (_: string, listener: Listener) => listeners.add(listener),
    removeEventListener: (_: string, listener: Listener) => listeners.delete(listener),
  });
  vi.stubGlobal('matchMedia', query);
  return { listeners, query };
}

describe('PrefersReducedMotion', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('starts with what the system asks for', () => {
    const { query } = mockMatchMedia(true);
    expect(TestBed.inject(PrefersReducedMotion).reduced()).toBe(true);
    expect(query).toHaveBeenCalledWith('(prefers-reduced-motion: reduce)');
  });

  it('follows changes and stops listening when destroyed', () => {
    const { listeners } = mockMatchMedia(false);
    const service = TestBed.inject(PrefersReducedMotion);
    expect(service.reduced()).toBe(false);
    listeners.forEach((listener) => listener({ matches: true } as MediaQueryListEvent));
    expect(service.reduced()).toBe(true);
    TestBed.resetTestingModule();
    expect(listeners.size).toBe(0);
  });

  it('assumes motion is fine when the browser cannot tell', () => {
    vi.stubGlobal('matchMedia', undefined);
    expect(TestBed.inject(PrefersReducedMotion).reduced()).toBe(false);
  });
});
