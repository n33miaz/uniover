import type {
  PcKeyV1BodyKey,
  PcKeyV1BodyModifiersItem,
} from '../../../core/api/generated/agent/pc_key_v1';
import type {
  PcKeyV2BodyKey,
  PcKeyV2BodyModifiersItem,
} from '../../../core/api/generated/agent/pc_key_v2';
import { LABELLED_SHORTCUTS, shortcutLabel } from '../ui/shortcut-labels';
import {
  PC_KEYS,
  PC_MODIFIERS,
  keyNeedsV2,
  type PcKey,
  type PcKeyV1,
  type PcKeyV2Only,
  type PcModifier,
} from './pc-types';
import {
  DEFAULT_PINNED,
  MAX_PINNED,
  SHORTCUTS,
  SHORTCUT_GROUPS,
  keysText,
  shortcutById,
} from './pc-shortcuts';

/** Verdadeiro só se os dois tipos são exatamente o mesmo (um a mais ou a menos em qualquer lado quebra a compilação). */
type Same<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

// O contrato é a fonte: estes tipos vêm do esquema `pc.key.v1`, gerado. Se o esquema ganhar ou perder uma tecla, ou um
// modificador, a tela e o catálogo precisam ser revistos, e isto deixa de compilar até serem.
const keysAreTheContractKeys: Same<PcKeyV1, PcKeyV1BodyKey> = true;
const modifiersAreTheContractModifiers: Same<PcModifier, PcKeyV1BodyModifiersItem> = true;
// O mesmo para a v2: as teclas dela são as da v1 mais as `PcKeyV2Only`, e os modificadores são os mesmos.
const v2KeysAreTheContractKeys: Same<PcKeyV1 | PcKeyV2Only, PcKeyV2BodyKey> = true;
const v2ModifiersAreTheContractModifiers: Same<PcModifier, PcKeyV2BodyModifiersItem> = true;
const everyKeyIsOneOfTheTwoContracts: Same<PcKey, PcKeyV2BodyKey> = true;

describe('shortcut catalog', () => {
  it('uses exactly the keys and modifiers of the current key contract', () => {
    expect(keysAreTheContractKeys).toBe(true);
    expect(modifiersAreTheContractModifiers).toBe(true);
    expect(v2KeysAreTheContractKeys).toBe(true);
    expect(v2ModifiersAreTheContractModifiers).toBe(true);
    expect(everyKeyIsOneOfTheTwoContracts).toBe(true);
  });

  it('every key shortcut is valid for the contract version it needs, with no modifier twice', () => {
    for (const shortcut of SHORTCUTS) {
      if (shortcut.action.kind !== 'keys') continue;
      const { key, modifiers } = shortcut.action;
      if (shortcut.needs === undefined) {
        // Sem `needs`, qualquer agente serve: a tecla e os modificadores são os da v1 (compila só se forem).
        const contractKey: PcKeyV1BodyKey = key as PcKeyV1;
        expect(PC_KEYS, shortcut.id).toContain(contractKey);
        expect(keyNeedsV2(key), shortcut.id).toBe(false);
        const v1Modifiers: PcKeyV1BodyModifiersItem[] = [...modifiers];
        expect(new Set(v1Modifiers).size, shortcut.id).toBe(v1Modifiers.length);
      } else {
        // Com `needs`, a tecla é uma das que só a v2 traz.
        const contractKey: PcKeyV2BodyKey = key;
        expect(PC_KEYS as readonly string[], shortcut.id).not.toContain(contractKey);
        expect(keyNeedsV2(key), shortcut.id).toBe(true);
        const v2Modifiers: PcKeyV2BodyModifiersItem[] = [...modifiers];
        expect(new Set(v2Modifiers).size, shortcut.id).toBe(v2Modifiers.length);
      }
      expect(modifiers.length, shortcut.id).toBeLessThanOrEqual(4);
      for (const modifier of modifiers) expect(PC_MODIFIERS, shortcut.id).toContain(modifier);
    }
  });

  it('marks as needing pc.key.v2 exactly the shortcuts whose key only that version has', () => {
    for (const shortcut of SHORTCUTS) {
      const needsV2 = shortcut.action.kind === 'keys' ? keyNeedsV2(shortcut.action.key) : false;
      if (shortcut.action.kind === 'goto-slide') expect(shortcut.needs, shortcut.id).toBe('key-v2');
      else expect(shortcut.needs === 'key-v2', shortcut.id).toBe(needsV2);
    }
    expect(SHORTCUTS.filter((shortcut) => shortcut.needs).map((shortcut) => shortcut.id)).toEqual([
      'print-screen',
      'context-menu',
      'zoom-in',
      'zoom-out',
      'zoom-reset',
      'slides-goto',
    ]);
  });

  it('what was left out for lack of keys is here, but only behind pc.key.v2: zoom, print screen, menu, slide N', () => {
    const text = (id: string) => keysText(shortcutById(id)!);
    expect(text('zoom-in')).toBe('Ctrl+=');
    expect(text('zoom-out')).toBe('Ctrl+-');
    expect(text('zoom-reset')).toBe('Ctrl+0');
    expect(text('print-screen')).toBe('PrtSc');
    expect(text('context-menu')).toBe('Menu');
    expect(shortcutById('slides-goto')!.action).toEqual({ kind: 'goto-slide' });
    expect(shortcutById('screenshot')!.needs).toBeUndefined();
    expect(text('screenshot')).toBe('Win+Shift+S');
  });

  it('only "Trocar janela" holds the Alt, and it stays a one-tap Alt+Tab for old agents', () => {
    expect(
      SHORTCUTS.filter((shortcut) => shortcut.switcher).map((shortcut) => shortcut.id),
    ).toEqual(['switch-window']);
    const shortcut = shortcutById('switch-window')!;
    expect(shortcut.needs).toBeUndefined();
    expect(shortcut.action).toEqual({ kind: 'keys', key: 'TAB', modifiers: ['ALT'] });
  });

  it('has what the media tabs use, all as keys of the old contract (any agent serves them)', () => {
    const MEDIA_TABS = [
      'video-back-5',
      'video-forward-5',
      'video-fullscreen',
      'video-subtitles',
      'slides-start',
      'slides-here',
      'slides-end',
      'slides-black',
      'slides-white',
    ];
    for (const id of MEDIA_TABS) {
      const shortcut = shortcutById(id);
      expect(shortcut, id).toBeDefined();
      expect(shortcut!.action.kind, id).toBe('keys');
      expect(shortcut!.needs, id).toBeUndefined();
      expect(shortcut!.group, id).toBe(id.startsWith('video') ? 'video' : 'slides');
    }
    // As teclas do vídeo (J, L, espaço) e a seta do slide que as abas mandam direto também são do catálogo.
    const keysOf = (id: string) => {
      const action = shortcutById(id)!.action;
      return action.kind === 'keys' ? [action.key, ...action.modifiers] : [];
    };
    expect(keysOf('video-back-10')).toEqual(['J']);
    expect(keysOf('video-forward-10')).toEqual(['L']);
    expect(keysOf('play-pause')).toEqual(['SPACE']);
    expect(keysOf('slides-next')).toEqual(['RIGHT']);
    expect(keysOf('slides-previous')).toEqual(['LEFT']);
    expect(keysOf('slides-here')).toEqual(['F5', 'SHIFT']);
  });

  it('lists every key of the contract once, at run time, for the check above', () => {
    expect(new Set(PC_KEYS).size).toBe(PC_KEYS.length);
    // 14 de navegação e edição, 12 de função e 26 letras.
    expect(PC_KEYS).toHaveLength(52);
  });

  it('has unique ids, in English kebab-case (they go to the device storage, never to the screen)', () => {
    const ids = SHORTCUTS.map((shortcut) => shortcut.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z]+(-[a-z0-9]+)*$/);
  });

  it('has the groups asked for, each with shortcuts, and every shortcut in a known group', () => {
    expect(SHORTCUT_GROUPS).toEqual(['edit', 'window', 'system', 'browser', 'video', 'slides']);
    for (const group of SHORTCUT_GROUPS) {
      expect(
        SHORTCUTS.filter((shortcut) => shortcut.group === group).length,
        group,
      ).toBeGreaterThan(3);
    }
    for (const shortcut of SHORTCUTS) expect(SHORTCUT_GROUPS).toContain(shortcut.group);
  });

  it('inside a group no two shortcuts are the same keys', () => {
    for (const group of SHORTCUT_GROUPS) {
      const combos = SHORTCUTS.filter((shortcut) => shortcut.group === group).map(keysText);
      expect(new Set(combos.filter(Boolean)).size, group).toBe(combos.filter(Boolean).length);
    }
  });

  it('covers what was asked: editing, window, system, browser, video and slides', () => {
    const text = (id: string) => keysText(shortcutById(id)!);
    // edição
    expect(
      ['copy', 'paste', 'cut', 'undo', 'redo', 'select-all', 'save', 'find'].map(text),
    ).toEqual(['Ctrl+C', 'Ctrl+V', 'Ctrl+X', 'Ctrl+Z', 'Ctrl+Y', 'Ctrl+A', 'Ctrl+S', 'Ctrl+F']);
    // janela
    expect(text('switch-window')).toBe('Alt+Tab');
    expect(text('close-window')).toBe('Alt+F4');
    expect(text('show-desktop')).toBe('Win+D');
    expect(text('task-view')).toBe('Win+Tab');
    expect(text('snap-left')).toBe('Win+←');
    expect(text('maximize')).toBe('Win+↑');
    // sistema
    expect(text('explorer')).toBe('Win+E');
    expect(text('task-manager')).toBe('Ctrl+Shift+Esc');
    expect(text('clipboard-history')).toBe('Win+V');
    // navegador
    expect(text('new-tab')).toBe('Ctrl+T');
    expect(text('close-tab')).toBe('Ctrl+W');
    expect(text('reopen-tab')).toBe('Ctrl+Shift+T');
    expect(text('reload')).toBe('F5');
    expect(text('back')).toBe('Alt+←');
    expect(text('forward')).toBe('Alt+→');
    // vídeo
    expect(text('play-pause')).toBe('Space');
    expect(text('video-fullscreen')).toBe('F');
    expect(text('video-back-5')).toBe('←');
    // apresentação
    expect(text('slides-start')).toBe('F5');
    expect(text('slides-end')).toBe('Esc');
    expect(text('slides-next')).toBe('→');
  });

  it('Lock is the power action of the PC, not the Win+L keys (injected input does not lock reliably)', () => {
    const lock = shortcutById('lock')!;
    expect(lock.action).toEqual({ kind: 'lock' });
    expect(keysText(lock)).toBe('');
    const nonKeys = SHORTCUTS.filter((shortcut) => shortcut.action.kind !== 'keys');
    expect(nonKeys.map((shortcut) => shortcut.id)).toEqual(['lock', 'slides-goto']);
    // Nenhum atalho de teclas é Win+L.
    expect(SHORTCUTS.map(keysText)).not.toContain('Win+L');
  });

  it('never puts Win alone behind a shortcut that works on any agent', () => {
    const v1Texts = SHORTCUTS.filter((shortcut) => !shortcut.needs).map(keysText);
    expect(v1Texts).not.toContain('Win');
    for (const text of v1Texts) expect(text).not.toMatch(/[+-]$|\+0$|\+\d$/);
  });

  it('has a label for every shortcut, and none for one that does not exist', () => {
    const ids = SHORTCUTS.map((shortcut) => shortcut.id).sort();
    expect([...LABELLED_SHORTCUTS].sort()).toEqual(ids);
    for (const id of ids) expect(shortcutLabel(id).length, id).toBeGreaterThan(1);
    // O rótulo diz o que o atalho faz, não as teclas.
    for (const id of ids) expect(shortcutLabel(id)).not.toMatch(/Ctrl\+|Alt\+|Win\+/);
  });

  it('starts with pinned shortcuts that exist, in a number that fits', () => {
    expect(DEFAULT_PINNED.length).toBeLessThanOrEqual(MAX_PINNED);
    expect(MAX_PINNED).toBe(12);
    for (const id of DEFAULT_PINNED) expect(shortcutById(id), id).toBeDefined();
    expect(new Set(DEFAULT_PINNED).size).toBe(DEFAULT_PINNED.length);
  });

  it('writes the keys as on the keyboard of the PC', () => {
    expect(
      keysText({
        id: 'x',
        group: 'edit',
        action: { kind: 'keys', key: 'PAGE_DOWN', modifiers: [] },
      }),
    ).toBe('PgDn');
    expect(
      keysText({
        id: 'x',
        group: 'edit',
        action: { kind: 'keys', key: 'A', modifiers: ['CTRL', 'SHIFT', 'ALT', 'WIN'] },
      }),
    ).toBe('Ctrl+Shift+Alt+Win+A');
  });
});
