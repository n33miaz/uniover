import type { PcFailure } from './pc-failure';

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

/**
 * O programa que precisa estar na frente no PC (`target` de `pc.key.*` e `pc.text.*`): `browser` (Chrome, Edge, Firefox, Brave ou
 * Opera), `spotify` ou `vlc`. Com ele o agente não aperta nada se a janela da frente for de outro programa.
 */
export type PcFocusTarget = 'browser' | 'spotify' | 'vlc';

/** A capacidade que o PC declara quando o agente confere o programa da frente (`target`). */
export const PC_TARGET_CAPABILITY = 'pc.target.v1';

/** O que um toque de tecla pode pedir além da tecla e dos modificadores. */
export interface PcKeyOptions {
  /** Quantas vezes apertar, de 1 a `PC_KEY_MAX_REPEAT`, num pedido só (Backspace e setas seguradas). */
  readonly repeat?: number;
  readonly action?: PcKeyAction;
  /** Só aperta com este programa na frente (só para um PC que declarou `pc.target.v1`). */
  readonly target?: PcFocusTarget;
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

export type PcPowerAction =
  | 'LOCK'
  | 'SLEEP'
  | 'SHUTDOWN'
  | 'CANCEL_SHUTDOWN'
  | 'RESTART'
  | 'LOGOFF'
  | 'HIBERNATE'
  | 'MONITOR_OFF';

/** Desligar ou reiniciar pedido: a falha (ou `null`) e a contagem que o agente aceitou (`null` se a API não a devolveu). */
export interface PcCountdownStart {
  readonly failure: PcFailure | null;
  readonly countdownId: string | null;
}

/**
 * A capacidade que o PC declara quando o agente entende `pc.power.v2` (reiniciar, encerrar a sessão e apagar o monitor; hibernar
 * pede também `PC_HIBERNATE_CAPABILITY`).
 */
export const PC_POWER_V2_CAPABILITY = 'pc.power.v2';

/** A capacidade que o PC só declara com a hibernação ligada nele: sem ela a tela nem mostra "Hibernar" (e a API recusaria). */
export const PC_HIBERNATE_CAPABILITY = 'pc.power.hibernate.v1';

/**
 * A capacidade que o PC declara quando o agente cancela só a contagem que o app mostra (pelo identificador; veio na 0.77.0). O
 * caminho que pede ao Windows sem forçar veio antes, na 0.74.2, sem capacidade própria: sem esta, o agente pode ser um anterior,
 * que agenda `shutdown /t` (prazo maior que zero implica `/f`) e fecha os programas sem pedir para salvar. Evidência
 * conservadora, não certeza.
 */
export const PC_POWER_CANCEL_CAPABILITY = 'pc.power.cancel.v1';

/** A capacidade que o PC declara quando o agente diz o que o Windows está tocando ("Tocando agora"). */
export const PC_MEDIA_STATE_CAPABILITY = 'pc.media.state.v1';

/** A capacidade que o PC declara quando o agente lê e troca o texto da área de transferência. */
export const PC_CLIPBOARD_CAPABILITY = 'pc.clipboard.v1';

/** O que o Windows diz estar tocando: `none` quando não há sessão de mídia (título, artista e programa vazios). */
export type PcPlaybackStatus = 'playing' | 'paused' | 'stopped' | 'none';

export interface PcNowPlaying {
  readonly status: PcPlaybackStatus;
  readonly title: string;
  readonly artist: string;
  /** O programa que toca, como o Windows o identifica (ex.: `Spotify.exe`). */
  readonly app: string;
}

const PLAYBACK_STATUSES: ReadonlySet<string> = new Set<PcPlaybackStatus>([
  'playing',
  'paused',
  'stopped',
  'none',
]);

/** O estado que veio da API no tipo da tela: um valor que ela não conhece vale como "parado" (há sessão, sem tocar). */
export function playbackStatusOf(status: string): PcPlaybackStatus {
  return PLAYBACK_STATUSES.has(status) ? (status as PcPlaybackStatus) : 'stopped';
}

/** O maior texto que atravessa a área de transferência, em caracteres (o do contrato, da API e do agente). */
export const PC_CLIPBOARD_MAX = 5000;

/** Tabulação e as duas quebras de linha: os únicos caracteres de controle que o contrato aceita. */
const CLIPBOARD_ALLOWED_CONTROLS: ReadonlySet<number> = new Set([0x09, 0x0a, 0x0d]);

/**
 * O texto cabe na área de transferência do PC? Não vazio, até `PC_CLIPBOARD_MAX` e sem caractere de controle além de tabulação e
 * quebras de linha (a API recusa os C0, o DEL e os C1, como o `char.IsControl` dela).
 */
export function clipboardTextFits(text: string): boolean {
  if (text.length === 0 || text.length > PC_CLIPBOARD_MAX) return false;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    const control = code < 0x20 || (code >= 0x7f && code <= 0x9f);
    if (control && !CLIPBOARD_ALLOWED_CONTROLS.has(code)) return false;
  }
  return true;
}

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

/** A capacidade que o PC declara quando o agente entende `pc.text.v2` (apagar, digitar e apertar uma tecla num pedido só). */
export const PC_TEXT_V2_CAPABILITY = 'pc.text.v2';

/**
 * A capacidade que o PC declara quando o agente entende `pc.text.v3`: a edição da v2 com quebra de linha e tabulação dentro do
 * texto (o texto colado com várias linhas vai inteiro, em ordem, em vez de virar uma tecla Enter por linha).
 */
export const PC_TEXT_V3_CAPABILITY = 'pc.text.v3';

/** A capacidade que o PC declara quando o agente entende `pc.click.v2` (clique com modificadores e com o intervalo do toque anterior). */
export const PC_CLICK_V2_CAPABILITY = 'pc.click.v2';

/** A tecla que uma edição de texto aperta no fim. */
export type PcTextKey = 'ENTER' | 'TAB';

/**
 * Uma edição do campo do PC num pedido só: apaga `erase` caracteres, digita `text` e aperta `key`, nesta ordem (`pc.text.v2`).
 * Pelo menos um dos três; `erase` de 1 a `PC_TEXT_MAX_ERASE`.
 */
export interface PcTextEdit {
  readonly erase?: number;
  readonly text?: string;
  readonly key?: PcTextKey;
}

/** O limite de caracteres apagados de um pedido (o da API e do agente). */
export const PC_TEXT_MAX_ERASE = 200;

/**
 * Quantos caracteres a digitação ao vivo apaga por pedido. Fica abaixo dos 100 apertos por segundo que o canal direto aceita
 * (cada apagado conta um, e a tecla do fim mais um): um apagar maior se divide em pedidos em ordem.
 */
export const PC_TEXT_ERASE_CHUNK = 80;

/** O pedido só cabe na `pc.text.v2`? Apagar ou apertar uma tecla no fim. Texto puro vai pela v1, que todo agente entende. */
export function textEditNeedsV2(edit: PcTextEdit): boolean {
  return (edit.erase ?? 0) > 0 || edit.key !== undefined;
}

/** O texto do pedido traz quebra de linha ou tabulação: só a `pc.text.v3` o leva (só para um PC que a declarou). */
export function textEditHasLines(edit: PcTextEdit): boolean {
  return edit.text !== undefined && /[\n\t]/.test(edit.text);
}

/** Os modificadores que um clique leva. O Windows fica de fora: soltá-lo depois do clique abriria o menu Iniciar. */
export type PcClickModifier = 'CTRL' | 'ALT' | 'SHIFT';

/** O que um clique pode pedir além do botão (`pc.click.v2`): modificadores e o intervalo desde o toque anterior. */
export interface PcClickOptions {
  readonly modifiers?: readonly PcClickModifier[];
  /** Milissegundos desde o toque anterior (o do duplo clique): o agente reproduz esse intervalo. */
  readonly gapMs?: number;
}

/** O maior intervalo que o pedido leva (o do contrato); acima disso o toque seguinte já não é um duplo clique. */
export const PC_CLICK_MAX_GAP_MS = 400;

/** O intervalo que vai ao pedido: inteiro de 0 a `PC_CLICK_MAX_GAP_MS` (o que passar é cortado; o que não for número vale 0). */
export function clampClickGap(gapMs: number | undefined): number {
  if (gapMs === undefined || !Number.isFinite(gapMs)) return 0;
  return Math.max(0, Math.min(PC_CLICK_MAX_GAP_MS, Math.round(gapMs)));
}

/** O clique só cabe na `pc.click.v2`? Modificador ou intervalo. Sem eles a API manda a v1 e qualquer agente serve. */
export function clickNeedsV2(options: PcClickOptions = {}): boolean {
  return (options.modifiers?.length ?? 0) > 0 || clampClickGap(options.gapMs) > 0;
}

/** A capacidade que o PC declara quando o agente entende `pc.pointer.zoom.v1` (o zoom da pinça: Ctrl apertado e a roda do mouse). */
export const PC_ZOOM_CAPABILITY = 'pc.pointer.zoom.v1';

/** A capacidade que o PC declara quando o agente entende `pc.volume.v1` (volume absoluto) e manda o nível de agora. */
export const PC_VOLUME_CAPABILITY = 'pc.volume.v1';

/** O maior zoom de um pedido, em cliques de roda (o da API e do agente). */
export const PC_ZOOM_MAX_STEPS = 12;

/** O zoom que vai ao pedido: inteiro de -12 a 12 (o que passar é cortado); `0` quando não é número ou arredonda para nada. */
export function clampZoomSteps(steps: number): number {
  if (!Number.isFinite(steps)) return 0;
  return Math.max(-PC_ZOOM_MAX_STEPS, Math.min(PC_ZOOM_MAX_STEPS, Math.trunc(steps)));
}

/** O que um pedido de volume absoluto leva: o nível (0 a 100) e/ou o mudo; pelo menos um. */
export interface PcVolumeChange {
  readonly level?: number;
  readonly muted?: boolean;
}

/** O nível que vai ao pedido: inteiro de 0 a 100 (o que passar é cortado; o que não for número vale 0). */
export function clampVolumeLevel(level: number): number {
  if (!Number.isFinite(level)) return 0;
  return Math.max(0, Math.min(100, Math.round(level)));
}
