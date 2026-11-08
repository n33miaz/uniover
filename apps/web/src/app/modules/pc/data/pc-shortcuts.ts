import type { PcKey, PcKeyV1, PcModifier } from './pc-types';

/** Os grupos da folha de atalhos, na ordem em que aparecem (depois dos fixados). */
export type ShortcutGroup = 'edit' | 'window' | 'system' | 'browser' | 'video' | 'slides';

export const SHORTCUT_GROUPS: readonly ShortcutGroup[] = [
  'edit',
  'window',
  'system',
  'browser',
  'video',
  'slides',
];

/** O que um atalho faz: uma tecla com modificadores (o contrato `pc.key.v1`) ou uma ação de energia do PC. */
export type ShortcutAction =
  | { readonly kind: 'keys'; readonly key: PcKeyV1; readonly modifiers: readonly PcModifier[] }
  | { readonly kind: 'lock' };

/**
 * Um atalho do catálogo: dados, sem texto. O rótulo (que descreve o que o atalho faz, não as teclas) mora em
 * `shortcut-labels`. Todo atalho de teclas só usa teclas e modificadores que o contrato **atual** aceita: nenhum botão que
 * dá erro. Fica de fora o que o contrato ainda não tem (dígitos e pontuação: zoom do navegador, ir ao slide N, Win sozinho).
 */
export interface PcShortcut {
  readonly id: string;
  readonly group: ShortcutGroup;
  readonly action: ShortcutAction;
}

const keys = (
  id: string,
  group: ShortcutGroup,
  key: PcKeyV1,
  ...modifiers: PcModifier[]
): PcShortcut => ({ id, group, action: { kind: 'keys', key, modifiers } });

export const SHORTCUTS: readonly PcShortcut[] = [
  // Edição
  keys('copy', 'edit', 'C', 'CTRL'),
  keys('paste', 'edit', 'V', 'CTRL'),
  keys('cut', 'edit', 'X', 'CTRL'),
  keys('undo', 'edit', 'Z', 'CTRL'),
  keys('redo', 'edit', 'Y', 'CTRL'),
  keys('select-all', 'edit', 'A', 'CTRL'),
  keys('save', 'edit', 'S', 'CTRL'),
  keys('find', 'edit', 'F', 'CTRL'),

  // Janela
  keys('switch-window', 'window', 'TAB', 'ALT'),
  keys('close-window', 'window', 'F4', 'ALT'),
  keys('show-desktop', 'window', 'D', 'WIN'),
  keys('task-view', 'window', 'TAB', 'WIN'),
  keys('snap-left', 'window', 'LEFT', 'WIN'),
  keys('snap-right', 'window', 'RIGHT', 'WIN'),
  keys('maximize', 'window', 'UP', 'WIN'),
  keys('minimize', 'window', 'DOWN', 'WIN'),
  keys('minimize-all', 'window', 'M', 'WIN'),

  // Sistema. Bloquear não é Win+L: a injeção de entrada não bloqueia de forma confiável, e o PC já tem a ação própria.
  { id: 'lock', group: 'system', action: { kind: 'lock' } },
  keys('explorer', 'system', 'E', 'WIN'),
  keys('run', 'system', 'R', 'WIN'),
  keys('task-manager', 'system', 'ESCAPE', 'CTRL', 'SHIFT'),
  keys('clipboard-history', 'system', 'V', 'WIN'),
  keys('screenshot', 'system', 'S', 'WIN', 'SHIFT'),
  keys('settings', 'system', 'I', 'WIN'),
  keys('search', 'system', 'S', 'WIN'),
  keys('project', 'system', 'P', 'WIN'),
  keys('quick-menu', 'system', 'X', 'WIN'),

  // Navegador
  keys('new-tab', 'browser', 'T', 'CTRL'),
  keys('close-tab', 'browser', 'W', 'CTRL'),
  keys('reopen-tab', 'browser', 'T', 'CTRL', 'SHIFT'),
  keys('next-tab', 'browser', 'TAB', 'CTRL'),
  keys('previous-tab', 'browser', 'TAB', 'CTRL', 'SHIFT'),
  keys('reload', 'browser', 'F5'),
  keys('back', 'browser', 'LEFT', 'ALT'),
  keys('forward', 'browser', 'RIGHT', 'ALT'),
  keys('address', 'browser', 'L', 'CTRL'),
  keys('new-window', 'browser', 'N', 'CTRL'),
  keys('browser-fullscreen', 'browser', 'F11'),

  // Vídeo (os atalhos do YouTube e dos players comuns; o player precisa estar em foco)
  keys('play-pause', 'video', 'SPACE'),
  keys('video-fullscreen', 'video', 'F'),
  keys('video-back-5', 'video', 'LEFT'),
  keys('video-forward-5', 'video', 'RIGHT'),
  keys('video-back-10', 'video', 'J'),
  keys('video-forward-10', 'video', 'L'),
  keys('video-volume-up', 'video', 'UP'),
  keys('video-volume-down', 'video', 'DOWN'),
  keys('video-mute', 'video', 'M'),
  keys('video-subtitles', 'video', 'C'),

  // Apresentação
  keys('slides-start', 'slides', 'F5'),
  keys('slides-here', 'slides', 'F5', 'SHIFT'),
  keys('slides-next', 'slides', 'RIGHT'),
  keys('slides-previous', 'slides', 'LEFT'),
  keys('slides-black', 'slides', 'B'),
  keys('slides-white', 'slides', 'W'),
  keys('slides-end', 'slides', 'ESCAPE'),
];

/** Quantos atalhos cabem em "Fixados". */
export const MAX_PINNED = 12;

/** Os fixados de quem ainda não escolheu: os que mais se usa sem teclado físico. */
export const DEFAULT_PINNED: readonly string[] = [
  'copy',
  'paste',
  'cut',
  'undo',
  'select-all',
  'switch-window',
  'task-view',
  'show-desktop',
  'close-window',
];

const BY_ID = new Map(SHORTCUTS.map((shortcut) => [shortcut.id, shortcut]));

export function shortcutById(id: string): PcShortcut | undefined {
  return BY_ID.get(id);
}

/** Como cada tecla aparece escrita (nomes do teclado do PC; não se traduzem). */
const KEY_NAME: Readonly<Partial<Record<PcKey, string>>> = {
  ESCAPE: 'Esc',
  TAB: 'Tab',
  ENTER: 'Enter',
  SPACE: 'Space',
  BACKSPACE: 'Backspace',
  DELETE: 'Del',
  UP: '↑',
  DOWN: '↓',
  LEFT: '←',
  RIGHT: '→',
  PAGE_UP: 'PgUp',
  PAGE_DOWN: 'PgDn',
};

const MODIFIER_NAME: Readonly<Record<PcModifier, string>> = {
  CTRL: 'Ctrl',
  SHIFT: 'Shift',
  ALT: 'Alt',
  WIN: 'Win',
};

/** As teclas do atalho escritas como no teclado ("Ctrl+Shift+Esc"); vazio para o que não é tecla (bloquear). */
export function keysText(shortcut: PcShortcut): string {
  if (shortcut.action.kind !== 'keys') return '';
  const { key, modifiers } = shortcut.action;
  return [...modifiers.map((modifier) => MODIFIER_NAME[modifier]), KEY_NAME[key] ?? key].join('+');
}
