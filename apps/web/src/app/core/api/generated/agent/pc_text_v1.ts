/* GERADO por `npm --prefix contracts run generate` — não editar. */

/**
 * API para agente: digitar um texto no campo em foco do PC, caractere a caractere. 1 a 200 caracteres, sem caracteres de controle (Enter e Tab são teclas em `pc.key.v1`).
 */
export interface PcTextV1Message {
  v: 1;
  id: string;
  type: 'pc.text.v1';
  source: string;
  target: string;
  ts: string;
  correlationId: string | null;
  body: PcTextV1Body;
}
export interface PcTextV1Body {
  text: string;
}
