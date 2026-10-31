/** As teclas especiais que a tela oferece (o catálogo completo do contrato é maior; aqui só o que há botão). */
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
  | 'F4'
  | 'A'
  | 'C'
  | 'D'
  | 'V'
  | 'X'
  | 'Z';

export type PcModifier = 'CTRL' | 'ALT' | 'SHIFT' | 'WIN';

export type PcMediaAction =
  'PLAY_PAUSE' | 'NEXT' | 'PREVIOUS' | 'STOP' | 'VOLUME_UP' | 'VOLUME_DOWN' | 'MUTE';

export type PcPowerAction = 'LOCK' | 'SLEEP' | 'SHUTDOWN' | 'CANCEL_SHUTDOWN';

export type PcClickButton = 'LEFT' | 'RIGHT' | 'MIDDLE';
