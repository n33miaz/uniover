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

/** As teclas que todo agente do PC entende: as do contrato `pc.key.v1` (a lista é fechada). */
export type PcKeyV1 =
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

/**
 * As teclas que só a `pc.key.v2` traz: a fileira de dígitos, as quatro pontuações estáveis só nos layouts americano e ABNT2 (as demais
 * saem pelo texto), Insert, Print Screen, a tecla de menu, Caps Lock, a tecla Windows sozinha e os modificadores como
 * tecla (para segurar entre toques). Um agente de antes dela não as entende: a API recusa com `pc-key-unsupported`.
 */
export type PcKeyV2Only =
  | 'D0'
  | 'D1'
  | 'D2'
  | 'D3'
  | 'D4'
  | 'D5'
  | 'D6'
  | 'D7'
  | 'D8'
  | 'D9'
  | 'MINUS'
  | 'EQUALS'
  | 'COMMA'
  | 'PERIOD'
  | 'INSERT'
  | 'PRINT_SCREEN'
  | 'APPS'
  | 'WIN'
  | 'CAPS_LOCK'
  | 'CTRL'
  | 'ALT'
  | 'SHIFT';

/** As teclas que a tela envia. */
export type PcKey = PcKeyV1 | PcKeyV2Only;

/** `PRESS` aperta e solta (padrão); `DOWN` e `UP` seguram e soltam um modificador entre toques (só `CTRL`, `ALT`, `SHIFT`, `WIN`). */
export type PcKeyAction = 'PRESS' | 'DOWN' | 'UP';

/** Os modificadores que dá para segurar entre toques (`DOWN`) e soltar (`UP`). */
export type PcHoldableKey = 'CTRL' | 'ALT' | 'SHIFT' | 'WIN';

const HOLDABLE_KEYS: ReadonlySet<string> = new Set<PcHoldableKey>(['CTRL', 'ALT', 'SHIFT', 'WIN']);

export function isHoldableKey(key: string): key is PcHoldableKey {
  return HOLDABLE_KEYS.has(key);
}

/** O que um toque de tecla pode pedir além da tecla e dos modificadores. */
export interface PcKeyOptions {
  /** Quantas vezes apertar, de 1 a `PC_KEY_MAX_REPEAT`, num pedido só (Backspace e setas seguradas). */
  readonly repeat?: number;
  readonly action?: PcKeyAction;
}

/** O limite de repetições de um pedido (o da API e do agente). */
export const PC_KEY_MAX_REPEAT = 50;

/** A capacidade que o PC declara quando o agente entende `pc.key.v2` (vem em `capabilities` do estado do PC). */
export const PC_KEY_V2_CAPABILITY = 'pc.key.v2';

const V2_ONLY_KEYS: ReadonlySet<string> = new Set<PcKeyV2Only>([
  'D0',
  'D1',
  'D2',
  'D3',
  'D4',
  'D5',
  'D6',
  'D7',
  'D8',
  'D9',
  'MINUS',
  'EQUALS',
  'COMMA',
  'PERIOD',
  'INSERT',
  'PRINT_SCREEN',
  'APPS',
  'WIN',
  'CAPS_LOCK',
  'CTRL',
  'ALT',
  'SHIFT',
]);

/** A repetição que vai ao pedido: inteiro de 1 a `PC_KEY_MAX_REPEAT` (o que passar é cortado, o que não for número vale 1). */
export function clampKeyRepeat(repeat: number | undefined): number {
  if (repeat === undefined || !Number.isFinite(repeat)) return 1;
  return Math.max(1, Math.min(PC_KEY_MAX_REPEAT, Math.trunc(repeat)));
}

/**
 * O pedido só cabe na `pc.key.v2`? Tecla nova, repetição ou segurar/soltar. Quando não, a API manda a v1 e qualquer agente
 * serve. É o que a tela usa para esconder o que o PC conectado não entende.
 */
export function keyNeedsV2(key: PcKey, options: PcKeyOptions = {}): boolean {
  return (
    V2_ONLY_KEYS.has(key) ||
    clampKeyRepeat(options.repeat) > 1 ||
    (options.action !== undefined && options.action !== 'PRESS')
  );
}

export type PcModifier = 'CTRL' | 'ALT' | 'SHIFT' | 'WIN';

/** As quatro teclas que a tela deixa "armadas" (valem para a próxima tecla), na ordem em que aparecem. */
export const PC_MODIFIERS: readonly PcModifier[] = ['CTRL', 'SHIFT', 'ALT', 'WIN'];

export type PcMediaAction =
  'PLAY_PAUSE' | 'NEXT' | 'PREVIOUS' | 'STOP' | 'VOLUME_UP' | 'VOLUME_DOWN' | 'MUTE';

export type PcPowerAction = 'LOCK' | 'SLEEP' | 'SHUTDOWN' | 'CANCEL_SHUTDOWN';

export type PcClickButton = 'LEFT' | 'RIGHT' | 'MIDDLE';

/**
 * Todas as teclas do contrato `pc.key.v1`, em tempo de execução. Um `Record` completo: o compilador recusa uma tecla que
 * falta ou que sobra em relação ao tipo `PcKeyV1` (e o teste confere o tipo contra o gerado do esquema do contrato).
 */
const KEY_TABLE: Readonly<Record<PcKeyV1, true>> = {
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

export const PC_KEYS: readonly PcKeyV1[] = Object.keys(KEY_TABLE) as PcKeyV1[];
