import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { TestBed } from '@angular/core/testing';
import {
  AppearanceService,
  PRE_SESSION_THEME_PREFERENCE_KEY,
  THEME_BAR_COLORS,
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

  describe('system bar color', () => {
    const colors = () =>
      Array.from(document.head.querySelectorAll('meta[name="theme-color"]')).map((m) => [
        m.getAttribute('media'),
        m.getAttribute('content'),
      ]);

    beforeEach(() => {
      for (const scheme of ['light', 'dark']) {
        const meta = document.createElement('meta');
        meta.setAttribute('name', 'theme-color');
        meta.setAttribute('media', `(prefers-color-scheme: ${scheme})`);
        meta.setAttribute('content', '#000000');
        document.head.append(meta);
      }
    });
    afterEach(() =>
      document.head.querySelectorAll('meta[name="theme-color"]').forEach((m) => m.remove()),
    );

    it('uses the same colors as the theme background and the index.html tags', () => {
      const styles = readFileSync(resolve(process.cwd(), 'src/styles.css'), 'utf8');
      const index = readFileSync(resolve(process.cwd(), 'src/index.html'), 'utf8');
      const bg = (block: string) => block.match(/--a-bg:\s*(#[0-9a-f]{6})/i)![1].toLowerCase();
      expect(bg(styles.split(':root[data-theme=')[0])).toBe(THEME_BAR_COLORS.light);
      expect(bg(styles.split(":root[data-theme='dark']")[1])).toBe(THEME_BAR_COLORS.dark);
      for (const scheme of ['light', 'dark'] as const) {
        expect(index).toContain(
          `<meta name="theme-color" media="(prefers-color-scheme: ${scheme})" content="${THEME_BAR_COLORS[scheme]}" />`,
        );
      }
    });

    it('every installed app manifest carries the light background as bar and splash color', () => {
      for (const folder of ['', 'tv/', 'pc/', 'treino/']) {
        const manifest = JSON.parse(
          readFileSync(resolve(process.cwd(), `public/${folder}manifest.webmanifest`), 'utf8'),
        ) as { theme_color: string; background_color: string };
        expect(manifest.theme_color.toLowerCase(), folder).toBe(THEME_BAR_COLORS.light);
        expect(manifest.background_color.toLowerCase(), folder).toBe(THEME_BAR_COLORS.light);
      }
    });

    it('swaps the bar color in the same call that swaps the theme', () => {
      service().set('dark');
      expect(attr()).toBe('dark');
      expect(colors().map(([, c]) => c)).toEqual(['#101512', '#101512']);
      service().set('light');
      expect(attr()).toBe('light');
      expect(colors().map(([, c]) => c)).toEqual(['#f2f5f1', '#f2f5f1']);
    });

    it('follows the system when it changes while automatic, and ignores it when fixed', () => {
      service().restore();
      systemDark = true;
      onChange?.();
      expect(attr()).toBe('dark');
      expect(colors()).toEqual([
        ['(prefers-color-scheme: light)', '#f2f5f1'],
        ['(prefers-color-scheme: dark)', '#101512'],
      ]);
      service().set('light');
      onChange?.();
      expect(colors().map(([, c]) => c)).toEqual(['#f2f5f1', '#f2f5f1']);
    });

    it('keeps each scheme with its own background while automatic', () => {
      service().restore();
      expect(colors()).toEqual([
        ['(prefers-color-scheme: light)', '#f2f5f1'],
        ['(prefers-color-scheme: dark)', '#101512'],
      ]);
    });

    it('paints both with the chosen theme when the app fixes one, and goes back on automatic', () => {
      systemDark = true;
      service().set('light');
      expect(colors().map(([, c]) => c)).toEqual(['#f2f5f1', '#f2f5f1']);
      service().set('dark');
      expect(colors().map(([, c]) => c)).toEqual(['#101512', '#101512']);
      service().set('auto');
      expect(colors().map(([, c]) => c)).toEqual(['#f2f5f1', '#101512']);
    });
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
