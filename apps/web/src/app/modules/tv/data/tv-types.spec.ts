import {
  clockText,
  dayClockText,
  normalizeShortcut,
  parseShortcuts,
  parseState,
  parseTvs,
  parseWatchdog,
  shortcutLabel,
  parsePowerOffOutcome,
  tvCanPowerOffSafely,
  tvSupports,
  TvShortcut,
  TvSummary,
} from './tv-types';

const shortcut = (overrides: Partial<TvShortcut> = {}): TvShortcut => ({
  id: 'a1',
  position: 1,
  package: 'exemplo.pacote',
  tvLabel: null,
  customLabel: null,
  enabled: true,
  installed: true,
  iconDataUri: null,
  ...overrides,
});

describe('parseState', () => {
  const base = {
    power: 'on',
    volume: 22,
    app: null,
    connection: 'hot',
    agentOnline: true,
    updatedAt: '2026-10-19T14:02:00Z',
  };

  it('reads a normal state', () => {
    expect(parseState(base)).toEqual({
      power: 'on',
      volume: 22,
      app: null,
      connection: 'hot',
      agentOnline: true,
      updatedAt: '2026-10-19T14:02:00Z',
      offlineSince: null,
    });
  });

  it('carries the offline instant only while the agent is off', () => {
    const since = '2026-10-28T22:24:00Z';
    expect(parseState({ ...base, agentOnline: false, offlineSince: since })?.offlineSince).toBe(
      since,
    );
    expect(
      parseState({ ...base, agentOnline: true, offlineSince: since })?.offlineSince,
    ).toBeNull();
  });

  it('keeps "hibernating" as the connection: a sleeping session is not a switched-off TV', () => {
    const state = parseState({ ...base, connection: 'hibernating' });
    expect(state?.connection).toBe('hibernating');
    expect(state?.power).toBe('on');
  });

  it('forces "disconnected" and drops the volume when the agent is offline', () => {
    const state = parseState({ ...base, agentOnline: false });
    expect(state).toMatchObject({ connection: 'disconnected', volume: null, agentOnline: false });
  });

  it('accepts the volume as text (the generated type allows number or string)', () => {
    expect(parseState({ ...base, volume: '30' })?.volume).toBe(30);
    expect(parseState({ ...base, volume: null })?.volume).toBeNull();
    expect(parseState({ ...base, volume: 'nada' })?.volume).toBeNull();
  });

  it('turns unknown texts into safe values', () => {
    const state = parseState({ ...base, power: 'ligada', connection: 'quente' });
    expect(state).toMatchObject({ power: 'unknown', connection: 'disconnected' });
  });

  it('rejects what is not an object', () => {
    expect(parseState(null)).toBeNull();
    expect(parseState('texto')).toBeNull();
  });
});

describe('parseShortcuts', () => {
  it('sorts by position and drops entries without id or position', () => {
    const list = parseShortcuts([
      shortcut({ id: 'c', position: 3 }),
      { id: 'sem-posicao' },
      shortcut({ id: 'a', position: 1 }),
      null,
      shortcut({ id: 'b', position: 2 }),
    ]);
    expect(list?.map((item) => item.id)).toEqual(['a', 'b', 'c']);
  });

  it('keeps the icon that came and reads a missing or invalid one as "no icon" (rows saved before the icons)', () => {
    const old: Partial<TvShortcut> = shortcut({ id: 'old', position: 1 });
    delete old.iconDataUri;
    const list = parseShortcuts([
      old,
      shortcut({ id: 'ok', position: 2, iconDataUri: 'data:image/png;base64,AAAA' }),
      { ...shortcut({ id: 'bad', position: 3 }), iconDataUri: 42 },
      shortcut({ id: 'null', position: 4, iconDataUri: null }),
    ]);
    expect(list?.map((item) => item.iconDataUri)).toEqual([
      null,
      'data:image/png;base64,AAAA',
      null,
      null,
    ]);
  });

  it('keeps "installed" as it came: "out of the control" and "left the TV" are different things', () => {
    const list = parseShortcuts([
      shortcut({ id: 'pinned', position: 1, enabled: true, installed: true }),
      shortcut({ id: 'hidden', position: 2, enabled: false, installed: true }),
      shortcut({ id: 'gone', position: 3, enabled: false, installed: false }),
    ]);
    expect(list?.map((item) => [item.enabled, item.installed])).toEqual([
      [true, true],
      [false, true],
      [false, false],
    ]);
  });

  it('reads a shortcut without "installed" (cache or mock from before the field) as installed when it was active', () => {
    const legacy = (id: string, position: number, enabled: boolean): Partial<TvShortcut> => {
      const item: Partial<TvShortcut> = shortcut({ id, position, enabled });
      delete item.installed;
      return item;
    };
    const list = parseShortcuts([legacy('on', 1, true), legacy('off', 2, false)]);
    expect(list?.map((item) => item.installed)).toEqual([true, false]);
  });

  it('returns null for what is not a list', () => {
    expect(parseShortcuts({})).toBeNull();
    expect(parseShortcuts(undefined)).toBeNull();
  });
});

describe('normalizeShortcut', () => {
  it('hands back the very same object when nothing needs fixing', () => {
    const item = shortcut();
    expect(normalizeShortcut(item)).toBe(item);
  });

  it('fills a missing "installed" from "enabled" and a missing icon with null, without touching the rest', () => {
    const old: Partial<TvShortcut> = shortcut({ customLabel: 'Sala', enabled: true });
    delete old.installed;
    delete old.iconDataUri;
    expect(normalizeShortcut(old as TvShortcut)).toEqual(
      shortcut({ customLabel: 'Sala', enabled: true, installed: true, iconDataUri: null }),
    );
  });
});

describe('shortcutLabel', () => {
  it('uses the owner name when there is one', () => {
    expect(shortcutLabel(shortcut({ customLabel: 'Sala' }))).toBe('Sala');
    expect(shortcutLabel(shortcut({ customLabel: '  Sala  ' }))).toBe('Sala');
  });

  it('then uses the name the agent publishes for the app', () => {
    expect(shortcutLabel(shortcut({ tvLabel: 'YouTube' }))).toBe('YouTube');
    expect(shortcutLabel(shortcut({ tvLabel: '  Play Store  ' }))).toBe('Play Store');
    expect(shortcutLabel(shortcut({ customLabel: 'Sala', tvLabel: 'YouTube' }))).toBe('Sala');
    expect(shortcutLabel(shortcut({ customLabel: '   ', tvLabel: 'YouTube' }))).toBe('YouTube');
  });

  it('only then falls back to "Atalho n" with the stable position, never to the package', () => {
    expect(shortcutLabel(shortcut({ position: 2 }))).toBe('Atalho 2');
    expect(shortcutLabel(shortcut({ position: 5, customLabel: '   ', tvLabel: '  ' }))).toBe(
      'Atalho 5',
    );
    expect(shortcutLabel(shortcut({ position: 3, package: 'com.exemplo.app' }))).toBe('Atalho 3');
  });
});

describe('parseWatchdog', () => {
  it('reads a valid event', () => {
    expect(
      parseWatchdog({ kind: 'repaired', severity: 'info', detail: 'ok', attempts: 2, at: 'x' }),
    ).toEqual({ kind: 'repaired', severity: 'info', detail: 'ok', attempts: 2, at: 'x' });
  });

  it('needs the kind and the time', () => {
    expect(parseWatchdog({ kind: 'repaired' })).toBeNull();
    expect(parseWatchdog({ at: 'x' })).toBeNull();
    expect(parseWatchdog(null)).toBeNull();
  });
});

describe('dayClockText', () => {
  it('shows day, month and local time, and nothing for a bad value', () => {
    expect(dayClockText('2026-10-28T22:24:00Z')).toMatch(/^28\/10 \d{2}:\d{2}$/);
    expect(dayClockText(null)).toBe('');
    expect(dayClockText('nada')).toBe('');
  });
});

describe('clockText', () => {
  it('formats HH:MM and gives an empty text for invalid dates', () => {
    expect(clockText(new Date(2026, 9, 19, 9, 5))).toBe('09:05');
    expect(clockText('texto')).toBe('');
    expect(clockText(null)).toBe('');
  });
});

const tv = (overrides: Partial<TvSummary> = {}): TvSummary => ({
  id: 'tv-1',
  name: 'Sala',
  isDefault: true,
  agentSlug: 'pc-casa',
  kind: 'android',
  online: true,
  capabilities: ['tv.remote', 'tv.kind.android', 'tv.adb'],
  allowBackgroundAppClosing: false,
  ...overrides,
});

describe('parseTvs', () => {
  it('reads the list and keeps what each TV says about itself', () => {
    const list = parseTvs({
      items: [
        {
          id: 'a',
          name: 'Sala',
          isDefault: true,
          agentSlug: 'pc',
          kind: 'android',
          online: true,
          capabilities: ['tv.adb'],
          allowBackgroundAppClosing: true,
        },
        {
          id: 'b',
          name: 'Quarto',
          isDefault: false,
          kind: 'samsung',
          online: false,
          capabilities: [],
        },
      ],
    });
    expect(list).toEqual([
      {
        id: 'a',
        name: 'Sala',
        isDefault: true,
        agentSlug: 'pc',
        kind: 'android',
        online: true,
        capabilities: ['tv.adb'],
        allowBackgroundAppClosing: true,
      },
      {
        id: 'b',
        name: 'Quarto',
        isDefault: false,
        agentSlug: null,
        kind: 'samsung',
        online: false,
        capabilities: [],
        allowBackgroundAppClosing: false,
      },
    ]);
  });

  it('drops entries without the minimum and rejects a body that is not a list', () => {
    expect(parseTvs({ items: [{ name: 'sem id' }, null, 'x', { id: 'a', name: 'ok' }] })).toEqual([
      {
        id: 'a',
        name: 'ok',
        isDefault: false,
        agentSlug: null,
        kind: null,
        online: false,
        capabilities: [],
        allowBackgroundAppClosing: false,
      },
    ]);
    expect(parseTvs({})).toBeNull();
    expect(parseTvs(null)).toBeNull();
    expect(parseTvs([])).toBeNull();
  });

  it('treats an unknown kind as unknown, never as a kind', () => {
    expect(parseTvs({ items: [{ id: 'a', name: 'x', kind: 'roku' }] })?.[0].kind).toBeNull();
  });
});

describe('desligar com leitura', () => {
  const tv = (capabilities: string[]): TvSummary => ({
    id: 'a',
    name: 'Sala',
    isDefault: true,
    agentSlug: null,
    kind: 'android',
    online: true,
    capabilities,
    allowBackgroundAppClosing: false,
  });

  it('only an agent that declares it can be asked for the safe power off', () => {
    expect(tvCanPowerOffSafely(tv(['tv.remote', 'tv.power.off.v1']))).toBe(true);
    expect(tvCanPowerOffSafely(tv(['tv.remote', 'tv.adb']))).toBe(false);
    expect(tvCanPowerOffSafely(tv([]))).toBe(false);
    expect(tvCanPowerOffSafely(null)).toBe(false);
  });

  it('reads the outcome of the answer and falls back to sent', () => {
    expect(parsePowerOffOutcome({ ok: true, outcome: 'off' })).toBe('off');
    expect(parsePowerOffOutcome({ ok: true, outcome: 'already_off' })).toBe('already_off');
    expect(parsePowerOffOutcome({ ok: true, outcome: 'sent' })).toBe('sent');
    expect(parsePowerOffOutcome({ ok: true })).toBe('sent');
    expect(parsePowerOffOutcome({ outcome: 'surprise' })).toBe('sent');
    expect(parsePowerOffOutcome(null)).toBe('sent');
    expect(parsePowerOffOutcome(undefined)).toBe('sent');
  });
});

describe('tvSupports', () => {
  it('offers everything when nothing is known about the TV (no list, or the agent is off)', () => {
    for (const feature of ['cleanup', 'text', 'apps'] as const) {
      expect(tvSupports(null, feature)).toBe(true);
      expect(tvSupports(tv({ kind: null, capabilities: [], online: false }), feature)).toBe(true);
    }
  });

  it('gives an Android with ADB cleanup, apps and text', () => {
    for (const feature of ['cleanup', 'text', 'apps'] as const) {
      expect(tvSupports(tv(), feature)).toBe(true);
    }
  });

  it('takes cleanup and text away from a Samsung, which still opens apps by its own channel', () => {
    const samsung = tv({ kind: 'samsung', capabilities: ['tv.remote', 'tv.kind.samsung'] });
    expect(tvSupports(samsung, 'cleanup')).toBe(false);
    expect(tvSupports(samsung, 'text')).toBe(false);
    expect(tvSupports(samsung, 'apps')).toBe(true);
  });

  it('takes cleanup and apps away from an Android without the ADB channel, but keeps text', () => {
    const noAdb = tv({ capabilities: ['tv.remote', 'tv.kind.android'] });
    expect(tvSupports(noAdb, 'cleanup')).toBe(false);
    expect(tvSupports(noAdb, 'apps')).toBe(false);
    expect(tvSupports(noAdb, 'text')).toBe(true);
  });
});
