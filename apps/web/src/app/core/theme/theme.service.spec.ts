import { TestBed } from '@angular/core/testing';
import { ThemeService } from './theme.service';

type Listener = (event: MediaQueryListEvent) => void;

function mockMatchMedia(matches: boolean) {
  const listeners = new Set<Listener>();
  vi.stubGlobal(
    'matchMedia',
    vi.fn().mockReturnValue({
      matches,
      addEventListener: (_: string, l: Listener) => listeners.add(l),
      removeEventListener: (_: string, l: Listener) => listeners.delete(l),
    }),
  );
  return listeners;
}

describe('ThemeService', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    document.documentElement.removeAttribute('data-theme');
  });

  it('applies dark when the system prefers dark', () => {
    mockMatchMedia(true);
    const service = TestBed.inject(ThemeService);
    expect(service.theme()).toBe('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });

  it('applies light when the system prefers light', () => {
    mockMatchMedia(false);
    TestBed.inject(ThemeService);
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });

  it('follows system changes', () => {
    const listeners = mockMatchMedia(false);
    const service = TestBed.inject(ThemeService);
    listeners.forEach((l) => l({ matches: true } as MediaQueryListEvent));
    expect(service.theme()).toBe('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });
});
