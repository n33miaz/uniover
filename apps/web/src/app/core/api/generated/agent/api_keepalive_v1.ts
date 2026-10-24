/* eslint-disable */
/* GERADO por `npm --prefix contracts run generate` — não editar. */

/**
 * API para agente: batimento sem efeito de negócio para manter o canal WebSocket ativo no proxy.
 */
export interface ApiKeepaliveV1Message {
  v: 1;
  id: string;
  type: 'api.keepalive.v1';
  source: string;
  target: string;
  ts: string;
  correlationId: null;
  body: ApiKeepaliveV1Body;
}
export interface ApiKeepaliveV1Body {}
