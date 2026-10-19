/* eslint-disable */
/* GERADO por `npm --prefix contracts run generate` — não editar. */

/**
 * API para agente: o app está aberto, então o agente aquece a sessão com a TV e renova o relógio de hibernação.
 */
export interface TvWakeV1Message {
  v: 1;
  id: string;
  type: 'tv.wake.v1';
  source: string;
  target: string;
  ts: string;
  correlationId: string | null;
  body: TvWakeV1Body;
}
export interface TvWakeV1Body {}
