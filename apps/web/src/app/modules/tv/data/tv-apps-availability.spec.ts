import { makeShortcut, makeTv } from '../tv-test-kit';
import { appsAvailability } from './tv-apps-availability';
import type { TvState } from './tv-types';

const state = (overrides: Partial<TvState> = {}): TvState => ({
  power: 'on',
  volume: null,
  app: null,
  connection: 'hot',
  agentOnline: true,
  updatedAt: null,
  ...overrides,
});

describe('appsAvailability', () => {
  const android = makeTv('a');
  const noAdb = makeTv('a', { capabilities: ['tv.remote', 'tv.kind.android'] });

  it('is ready whenever the list has an installed app, even with the TV off now', () => {
    expect(
      appsAvailability({
        shortcuts: [makeShortcut(1)],
        state: state({ power: 'off', agentOnline: false }),
        tv: noAdb,
      }),
    ).toBe('ready');
  });

  it('says the computer is off before anything else', () => {
    expect(
      appsAvailability({ shortcuts: [], state: state({ agentOnline: false }), tv: noAdb }),
    ).toBe('pc-off');
  });

  it('waits while the list has not arrived', () => {
    expect(appsAvailability({ shortcuts: null, state: state(), tv: android })).toBe('loading');
  });

  it('tells an Android TV whose computer did not declare the ADB', () => {
    expect(appsAvailability({ shortcuts: [], state: state(), tv: noAdb })).toBe('no-adb');
    // Sem lista de capacidades (agente fora, servidor antigo) não se presume falta.
    expect(
      appsAvailability({ shortcuts: [], state: state(), tv: { ...noAdb, capabilities: [] } }),
    ).toBe('empty');
    // A Samsung lista apps pelo canal dela, sem ADB.
    expect(
      appsAvailability({
        shortcuts: [],
        state: state(),
        tv: makeTv('s', { kind: 'samsung', capabilities: ['tv.kind.samsung'] }),
      }),
    ).toBe('empty');
  });

  it('tells a missing or pending ADB permission', () => {
    expect(
      appsAvailability({ shortcuts: [], state: state({ adbPermission: 'missing' }), tv: android }),
    ).toBe('adb-permission');
    expect(
      appsAvailability({ shortcuts: [], state: state({ adbPermission: 'pending' }), tv: android }),
    ).toBe('adb-pending');
  });

  it('tells a TV that is off or not answering', () => {
    expect(appsAvailability({ shortcuts: [], state: state({ power: 'off' }), tv: android })).toBe(
      'tv-off',
    );
    expect(
      appsAvailability({
        shortcuts: [],
        state: state({ connection: 'disconnected' }),
        tv: android,
      }),
    ).toBe('tv-off');
  });

  it('counts a list with only uninstalled apps as empty', () => {
    expect(
      appsAvailability({
        shortcuts: [makeShortcut(1, { installed: false })],
        state: state(),
        tv: android,
      }),
    ).toBe('empty');
  });
});
