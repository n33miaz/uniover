import { LABELLED_REMOTE_BUTTONS, remoteName } from '../ui/remote-labels';
import { REMOTE_ICON } from '../ui/remote-icons';
import { REMOTES, remoteById, type RemoteButton } from './pc-remotes';
import { shortcutById } from './pc-shortcuts';
import { keyNeedsV2 } from './pc-types';

const all = (remote: (typeof REMOTES)[number]): RemoteButton[] => [
  ...(remote.transport
    ? [remote.transport.previous, remote.transport.toggle, remote.transport.next]
    : []),
  ...remote.buttons,
];

describe('pc-remotes', () => {
  it('lists the six programs in order, each with a name, a drawing and an official source', () => {
    expect(REMOTES.map((remote) => remote.id)).toEqual([
      'navegador',
      'youtube',
      'netflix',
      'spotify',
      'vlc',
      'teclado-numerico',
    ]);
    for (const remote of REMOTES) {
      expect(remoteName(remote.id)).toBeTruthy();
      expect(REMOTE_ICON[remote.id]).toBeTruthy();
      expect(remote.source).toMatch(/^https:\/\//);
    }
  });

  it('a button id is unique inside its program, and so is what it sends', () => {
    for (const remote of REMOTES) {
      const buttons = all(remote);
      expect(new Set(buttons.map((b) => b.id)).size, remote.id).toBe(buttons.length);
      const sends = buttons.map((b) => JSON.stringify(b.action));
      expect(new Set(sends).size, remote.id).toBe(sends.length);
    }
  });

  it('every key that only pc.key.v2 has is marked, and nothing else is', () => {
    for (const remote of REMOTES) {
      for (const button of all(remote)) {
        const v2 = button.action.kind === 'keys' && keyNeedsV2(button.action.key);
        expect(button.needs === 'key-v2', `${remote.id}/${button.id}`).toBe(v2);
      }
    }
  });

  it('the three big buttons are plain keys or media, never something that needs pc.key.v2', () => {
    for (const remote of REMOTES) {
      if (!remote.transport) continue;
      for (const button of [
        remote.transport.previous,
        remote.transport.toggle,
        remote.transport.next,
      ]) {
        expect(button.needs, `${remote.id}/${button.id}`).toBeUndefined();
        expect(button.action.kind).not.toBe('text');
      }
    }
  });

  it('the browser takes its keys from the shortcut catalog', () => {
    for (const button of remoteById('navegador')!.buttons) {
      const shortcut = shortcutById(button.id);
      expect(shortcut?.group, button.id).toBe('browser');
      expect(button.action).toEqual(shortcut!.action);
    }
  });

  it('every button with a drawing has a label (the number pad shows the character itself)', () => {
    for (const remote of REMOTES) {
      if (remote.id === 'teclado-numerico') continue;
      for (const button of all(remote))
        expect(LABELLED_REMOTE_BUTTONS, button.id).toContain(button.id);
    }
  });

  it('the number pad needs pc.key.v2 as a whole', () => {
    expect(remoteById('teclado-numerico')!.needs).toBe('key-v2');
    expect(REMOTES.filter((remote) => remote.needs).map((remote) => remote.id)).toEqual([
      'teclado-numerico',
    ]);
  });

  it('every program names what must be in front on the PC; the number pad does not need one', () => {
    expect(Object.fromEntries(REMOTES.map((remote) => [remote.id, remote.target ?? null]))).toEqual(
      {
        navegador: 'browser',
        youtube: 'browser',
        netflix: 'browser',
        spotify: 'spotify',
        vlc: 'vlc',
        'teclado-numerico': null,
      },
    );
  });

  it('only closing a tab needs a long press', () => {
    const held = REMOTES.flatMap((remote) =>
      all(remote)
        .filter((button) => button.hold)
        .map((button) => `${remote.id}/${button.id}`),
    );
    expect(held).toEqual(['navegador/close-tab']);
  });

  it('an unknown or empty id is no program', () => {
    expect(remoteById('winamp')).toBeUndefined();
    expect(remoteById(null)).toBeUndefined();
  });
});
