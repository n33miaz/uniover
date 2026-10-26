import { TestBed } from '@angular/core/testing';
import {
  AppearanceService,
  PRE_SESSION_THEME_PREFERENCE_KEY,
  THEME_PREFERENCE_KEY,
  themePreferenceStorageKey,
} from './appearance.service';
import { SessionState } from './session-state';

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

  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
    document.documentElement.removeAttribute('data-theme');
  });

  const identify = (id: string, role: 'owner' | 'guest' = 'owner') =>
    TestBed.inject(SessionState).setUser({
      id,
      email: `${id}@exemplo.com`,
      displayName: id,
      role,
    });

  it('defaults to automatic and follows the system', () => {
    systemDark = true;
    expect(service().preference()).toBe('auto');
    service().restore();
    expect(attr()).toBe('dark');
  });

  it('a fixed choice is saved locally and applied', () => {
    service().set('light');
    expect(attr()).toBe('light');
    expect(localStorage.getItem(PRE_SESSION_THEME_PREFERENCE_KEY)).toBe('light');
  });

  it('restores the pre-session preference on a fresh load', () => {
    localStorage.setItem(PRE_SESSION_THEME_PREFERENCE_KEY, 'dark');
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
    expect(localStorage.getItem(PRE_SESSION_THEME_PREFERENCE_KEY)).toBe('auto');
  });

  it('keeps each signed-in account theme separate when the account changes in the same tab', () => {
    const appearance = service();
    identify('conta-a');
    appearance.set('dark');
    expect(localStorage.getItem(themePreferenceStorageKey('conta-a'))).toBe('dark');

    TestBed.inject(SessionState).clear();
    identify('conta-b');
    TestBed.tick();
    expect(appearance.preference()).toBe('auto');
    expect(attr()).toBe('light');
    appearance.set('light');
    expect(localStorage.getItem(themePreferenceStorageKey('conta-b'))).toBe('light');

    identify('conta-a');
    TestBed.tick();
    expect(appearance.preference()).toBe('dark');
    expect(attr()).toBe('dark');
  });

  it('copies the old preference only to the first confirmed owner, before relying on the new key', () => {
    localStorage.setItem(THEME_PREFERENCE_KEY, 'dark');
    const appearance = service();

    identify('conta-a');
    expect(appearance.preference()).toBe('dark');
    expect(localStorage.getItem(themePreferenceStorageKey('conta-a'))).toBe('dark');
    expect(localStorage.getItem(THEME_PREFERENCE_KEY)).toBe('dark');

    TestBed.inject(SessionState).clear();
    identify('conta-b');
    expect(appearance.preference()).toBe('auto');
    expect(localStorage.getItem(themePreferenceStorageKey('conta-b'))).toBeNull();
  });

  it('paints the old preference from the first frame when only the account hint is known, then lets /me decide', () => {
    localStorage.setItem(THEME_PREFERENCE_KEY, 'dark');
    localStorage.setItem('uniover.account-id', 'convidado');
    const appearance = service();
    appearance.restore();
    expect(attr()).toBe('dark');
    // A dica ainda não é a conta confirmada: nada é gravado para ela.
    expect(localStorage.getItem(themePreferenceStorageKey('convidado'))).toBeNull();

    identify('convidado', 'guest');
    TestBed.tick();
    expect(appearance.preference()).toBe('auto');
    expect(attr()).toBe('light');
  });

  it('keeps the old preference for the owner once /me confirms the hinted account', () => {
    localStorage.setItem(THEME_PREFERENCE_KEY, 'dark');
    localStorage.setItem('uniover.account-id', 'conta-a');
    const appearance = service();
    appearance.restore();
    expect(attr()).toBe('dark');

    identify('conta-a');
    TestBed.tick();
    expect(appearance.preference()).toBe('dark');
    expect(attr()).toBe('dark');
    expect(localStorage.getItem(themePreferenceStorageKey('conta-a'))).toBe('dark');
  });

  it('does not give the old preference to a guest before an owner claims it', () => {
    localStorage.setItem(THEME_PREFERENCE_KEY, 'dark');
    const appearance = service();

    identify('convidado', 'guest');
    expect(appearance.preference()).toBe('auto');

    TestBed.inject(SessionState).clear();
    identify('conta-a');
    expect(appearance.preference()).toBe('dark');
    expect(localStorage.getItem(themePreferenceStorageKey('conta-a'))).toBe('dark');
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
