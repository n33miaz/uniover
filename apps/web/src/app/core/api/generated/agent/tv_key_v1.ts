/* GERADO por `npm --prefix contracts run generate` — não editar. */

export type TvKeyV1BodyKey =
  | 'POWER'
  | 'HOME'
  | 'BACK'
  | 'UP'
  | 'DOWN'
  | 'LEFT'
  | 'RIGHT'
  | 'OK'
  | 'VOLUME_UP'
  | 'VOLUME_DOWN'
  | 'MUTE'
  | 'CHANNEL_UP'
  | 'CHANNEL_DOWN'
  | 'PLAY_PAUSE';

/**
 * API para agente: pressionar uma tecla da TV.
 */
export interface TvKeyV1Message {
  v: 1;
  id: string;
  type: 'tv.key.v1';
  source: string;
  target: string;
  ts: string;
  correlationId: string | null;
  body: TvKeyV1Body;
}
export interface TvKeyV1Body {
  key: TvKeyV1BodyKey;
}
