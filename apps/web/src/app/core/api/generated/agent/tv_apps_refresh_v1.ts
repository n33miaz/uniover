/* eslint-disable */
/* GERADO por `npm --prefix contracts run generate` — não editar. */

/**
 * API para agente: pedir a lista de apps instalados na TV (a resposta vem em tv.apps.v1).
 */
export interface TvAppsRefreshV1Message {
  v: 1;
  id: string;
  type: 'tv.apps.refresh.v1';
  source: string;
  target: string;
  ts: string;
  correlationId: string | null;
  body: TvAppsRefreshV1Body;
}
export interface TvAppsRefreshV1Body {}
