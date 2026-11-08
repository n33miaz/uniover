/* GERADO por `npm --prefix contracts run generate` — não editar. */

export type PcKeyV2BodyKey =
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
  | 'Z'
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
export type PcKeyV2BodyModifiersItem = 'CTRL' | 'ALT' | 'SHIFT' | 'WIN';
export type PcKeyV2BodyAction = 'PRESS' | 'DOWN' | 'UP';

/**
 * API para agente: uma tecla do teclado, com modificadores opcionais, repetida em um só pedido (`repeat`) ou apertada e segurada em dois tempos (`action`). A lista de teclas é fechada: o agente nunca digita um código que não esteja aqui. As teclas de pontuação são só as que o Windows mantém iguais em qualquer layout; as demais saem pelo `pc.text`.
 */
export interface PcKeyV2Message {
  v: 1;
  id: string;
  type: 'pc.key.v2';
  source: string;
  target: string;
  ts: string;
  correlationId: string | null;
  body: PcKeyV2Body;
}
export interface PcKeyV2Body {
  key: PcKeyV2BodyKey;
  /**
   * @maxItems 4
   */
  modifiers?:
    | []
    | [PcKeyV2BodyModifiersItem]
    | [PcKeyV2BodyModifiersItem, PcKeyV2BodyModifiersItem]
    | [PcKeyV2BodyModifiersItem, PcKeyV2BodyModifiersItem, PcKeyV2BodyModifiersItem]
    | [
        PcKeyV2BodyModifiersItem,
        PcKeyV2BodyModifiersItem,
        PcKeyV2BodyModifiersItem,
        PcKeyV2BodyModifiersItem,
      ];
  repeat?: number;
  action?: PcKeyV2BodyAction;
}
