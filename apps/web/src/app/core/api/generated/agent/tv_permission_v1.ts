/* GERADO por `npm --prefix contracts run generate` — não editar. */

export type TvPermissionV1BodyState = 'needed' | 'granted';

/**
 * Agente para API: o estado da permissão do UniOver na TV Samsung. 'needed': a TV não reconhece mais o UniOver (permissão revogada ou vencida) e o agente parou de tentar, sem pedir de novo em silêncio. 'granted': a TV aceitou. Sai quando o estado muda e de novo depois de cada hello; correlationId é nulo.
 */
export interface TvPermissionV1Message {
  v: 1;
  id: string;
  type: 'tv.permission.v1';
  source: string;
  target: string;
  ts: string;
  correlationId: string | null;
  body: TvPermissionV1Body;
}
export interface TvPermissionV1Body {
  state: TvPermissionV1BodyState;
  at: string;
}
