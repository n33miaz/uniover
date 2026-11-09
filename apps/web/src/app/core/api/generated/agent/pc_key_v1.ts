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
 * API para agente: uma tecla do teclado, com modificadores opcionais (atalhos como Ctrl+C). A lista de teclas é fechada: o agente nunca digita um código que não esteja aqui. `seq` (opcional) numera os pedidos de entrada pela nuvem em ordem crescente (um contador só para o clique, a tecla, o texto e a mídia, durante a vida da página; o movimento tem a numeração própria dele): o agente o compara com o último número que o app declara no canal direto para saber se um pedido da nuvem é anterior à troca de caminho (e por isso não fecha o canal) ou é novo. A API só o repassa a um agente que declara `pc.rtc.v1`.
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
  seq?: number;
}
