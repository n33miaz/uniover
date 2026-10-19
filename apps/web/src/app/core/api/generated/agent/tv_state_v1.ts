/* GERADO por `npm --prefix contracts run generate` — não editar. */

export type TvStateV1BodyPower = 'on' | 'off' | 'unknown';
export type TvStateV1BodyConnection = 'hot' | 'hibernating' | 'disconnected';

/**
 * Agente para API: estado atual da TV.
 */
export interface TvStateV1Message {
  v: 1;
  id: string;
  type: 'tv.state.v1';
  source: string;
  target: string;
  ts: string;
  correlationId: string | null;
  body: TvStateV1Body;
}
export interface TvStateV1Body {
  power: TvStateV1BodyPower;
  volume: number | null;
  app: string | null;
  connection: TvStateV1BodyConnection;
}
