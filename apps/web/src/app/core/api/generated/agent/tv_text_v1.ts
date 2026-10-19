/* GERADO por `npm --prefix contracts run generate` — não editar. */

/**
 * API para agente: digitar um texto no campo em foco da TV.
 */
export interface TvTextV1Message {
  v: 1;
  id: string;
  type: 'tv.text.v1';
  source: string;
  target: string;
  ts: string;
  correlationId: string | null;
  body: TvTextV1Body;
}
export interface TvTextV1Body {
  text: string;
}
