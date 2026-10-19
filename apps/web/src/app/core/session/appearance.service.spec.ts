import { TestBed } from '@angular/core/testing';
import { AppearanceService, THEME_PREFERENCE_KEY } from './appearance.service';

describe('AppearanceService', () => {
  const service = () => TestBed.inject(AppearanceService);
  const attr = () => document.documentElement.getAttribute('data-theme');
  let systemDark = false;
  let onChange: (() => void) | undefined;

  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute('data-theme');
    systemDark = false;
    onChange = undefined;
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({
        get matches() {
          return systemDark;
        },
        addEventListener: (_type: string, listener: () => void) => (onChange = listener),
        removeEventListener: () => undefined,
      })),
    );
  });

  afterEach(() => vi.unstubAllGlobals());

  it('defaults to automatic and follows the system', () => {
    systemDark = true;
    expect(service().preference()).toBe('auto');
    service().restore();
    expect(attr()).toBe('dark');
  });

  it('a fixed choice is saved locally and applied', () => {
    service().set('light');
    expect(attr()).toBe('light');
    expect(localStorage.getItem(THEME_PREFERENCE_KEY)).toBe('light');
  });

  it('restores the saved preference on a fresh load', () => {
    localStorage.setItem(THEME_PREFERENCE_KEY, 'dark');
    service().restore();
    expect(service().preference()).toBe('dark');
    expect(attr()).toBe('dark');
  });

  it('ignores a corrupted stored value', () => {
    localStorage.setItem(THEME_PREFERENCE_KEY, 'roxo');
    expect(service().preference()).toBe('auto');
  });

  it('a fixed choice survives the system changing theme', () => {
    service().set('light');
    systemDark = true;
    onChange?.();
    expect(attr()).toBe('light');
  });

  it('going back to automatic applies the system theme again', () => {
    service().set('dark');
    service().set('auto');
    expect(attr()).toBe('light');
    expect(localStorage.getItem(THEME_PREFERENCE_KEY)).toBe('auto');
  });

  it('works when localStorage is blocked', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('bloqueado');
    });
    expect(() => service().set('dark')).not.toThrow();
    expect(attr()).toBe('dark');
    vi.restoreAllMocks();
  });
});
