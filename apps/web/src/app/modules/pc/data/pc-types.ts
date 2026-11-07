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
