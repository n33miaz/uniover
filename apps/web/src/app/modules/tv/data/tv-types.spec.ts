import {
  clockText,
  parseShortcuts,
  parseState,
  parseWatchdog,
  shortcutLabel,
  TvShortcut,
} from './tv-types';

const shortcut = (overrides: Partial<TvShortcut> = {}): TvShortcut => ({
  id: 'a1',
  position: 1,
  package: 'exemplo.pacote',
  tvLabel: null,
  customLabel: null,
  enabled: true,
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
    });
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

  it('returns null for what is not a list', () => {
    expect(parseShortcuts({})).toBeNull();
    expect(parseShortcuts(undefined)).toBeNull();
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

describe('clockText', () => {
  it('formats HH:MM and gives an empty text for invalid dates', () => {
    expect(clockText(new Date(2026, 9, 19, 9, 5))).toBe('09:05');
    expect(clockText('texto')).toBe('');
    expect(clockText(null)).toBe('');
  });
});
