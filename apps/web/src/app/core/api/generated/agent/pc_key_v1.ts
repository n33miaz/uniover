/* GERADO por `npm --prefix contracts run generate` — não editar. */

export type PcKeyV1BodyKey =
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
  | 'Z';
export type PcKeyV1BodyModifiersItem = 'CTRL' | 'ALT' | 'SHIFT' | 'WIN';

/**
 * API para agente: uma tecla do teclado, com modificadores opcionais (atalhos como Ctrl+C). A lista de teclas é fechada: o agente nunca digita um código que não esteja aqui.
 */
export interface PcKeyV1Message {
  v: 1;
  id: string;
  type: 'pc.key.v1';
  source: string;
  target: string;
  ts: string;
  correlationId: string | null;
  body: PcKeyV1Body;
}
export interface PcKeyV1Body {
  key: PcKeyV1BodyKey;
  /**
   * @maxItems 4
   */
  modifiers?:
    | []
    | [PcKeyV1BodyModifiersItem]
    | [PcKeyV1BodyModifiersItem, PcKeyV1BodyModifiersItem]
    | [PcKeyV1BodyModifiersItem, PcKeyV1BodyModifiersItem, PcKeyV1BodyModifiersItem]
    | [
        PcKeyV1BodyModifiersItem,
        PcKeyV1BodyModifiersItem,
        PcKeyV1BodyModifiersItem,
        PcKeyV1BodyModifiersItem,
      ];
}
