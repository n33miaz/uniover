/* GERADO por `npm --prefix contracts run generate` — não editar. */

/**
 * Agente para API: posição física do cursor do mouse no desktop virtual ('s.cur'), enviada no canal WebRTC ('screen').
 */
export interface PcScreenCurV1Message {
  v: 1;
  id: string;
  type: 'pc.screen.cur.v1';
  source: string;
  target: string;
  ts: string;
  correlationId: string | null;
  body: PcScreenCurV1Body;
}
export interface PcScreenCurV1Body {
  k: 's.cur';
  x: number;
  y: number;
}
