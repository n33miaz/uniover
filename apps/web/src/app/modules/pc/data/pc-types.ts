/** As letras do contrato (digitadas pelo campo de texto quando há modificador armado, e nos atalhos). */
export type PcLetter =
  | 'A'
  | 'B'
  | 'C'
  | 'D'
  | 'E'
  | 'F'
  | 'G'
  | 'H'
  | 'I'
  | 'J'
  | 'K'
  | 'L'
  | 'M'
  | 'N'
  | 'O'
  | 'P'
  | 'Q'
  | 'R'
  | 'S'
  | 'T'
  | 'U'
  | 'V'
  | 'W'
  | 'X'
  | 'Y'
  | 'Z';

/** As teclas que a tela envia: as do contrato `pc.key.v1` (a lista é fechada; dígitos e pontuação não existem nela). */
export type PcKey =
  | 'ENTER'
  | 'BACKSPACE'
  | 'DELETE'
  | 'TAB'
  | 'ESCAPE'
  | 'SPACE'
  | 'UP'
  | 'DOWN'
  | 'LEFT'
  | 'RIGHT'
  | 'HOME'
  | 'END'
  | 'PAGE_UP'
  | 'PAGE_DOWN'
  | 'F1'
  | 'F2'
  | 'F3'
  | 'F4'
  | 'F5'
  | 'F6'
  | 'F7'
  | 'F8'
  | 'F9'
  | 'F10'
  | 'F11'
  | 'F12'
  | PcLetter;

export type PcModifier = 'CTRL' | 'ALT' | 'SHIFT' | 'WIN';

/** As quatro teclas que a tela deixa "armadas" (valem para a próxima tecla), na ordem em que aparecem. */
export const PC_MODIFIERS: readonly PcModifier[] = ['CTRL', 'SHIFT', 'ALT', 'WIN'];

export type PcMediaAction =
  'PLAY_PAUSE' | 'NEXT' | 'PREVIOUS' | 'STOP' | 'VOLUME_UP' | 'VOLUME_DOWN' | 'MUTE';

export type PcPowerAction = 'LOCK' | 'SLEEP' | 'SHUTDOWN' | 'CANCEL_SHUTDOWN';

export type PcClickButton = 'LEFT' | 'RIGHT' | 'MIDDLE';

/**
 * Todas as teclas do contrato `pc.key.v1`, em tempo de execução. Um `Record` completo: o compilador recusa uma tecla que
 * falta ou que sobra em relação ao tipo `PcKey` (e o teste confere o tipo contra o gerado do esquema do contrato).
 */
const KEY_TABLE: Readonly<Record<PcKey, true>> = {
  ENTER: true,
  BACKSPACE: true,
  DELETE: true,
  TAB: true,
  ESCAPE: true,
  SPACE: true,
  UP: true,
  DOWN: true,
  LEFT: true,
  RIGHT: true,
  HOME: true,
  END: true,
  PAGE_UP: true,
  PAGE_DOWN: true,
  F1: true,
  F2: true,
  F3: true,
  F4: true,
  F5: true,
  F6: true,
  F7: true,
  F8: true,
  F9: true,
  F10: true,
  F11: true,
  F12: true,
  A: true,
  B: true,
  C: true,
  D: true,
  E: true,
  F: true,
  G: true,
  H: true,
  I: true,
  J: true,
  K: true,
  L: true,
  M: true,
  N: true,
  O: true,
  P: true,
  Q: true,
  R: true,
  S: true,
  T: true,
  U: true,
  V: true,
  W: true,
  X: true,
  Y: true,
  Z: true,
};

export const PC_KEYS: readonly PcKey[] = Object.keys(KEY_TABLE) as PcKey[];
