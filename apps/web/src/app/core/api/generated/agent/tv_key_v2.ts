/* GERADO por `npm --prefix contracts run generate` — não editar. */

export type TvKeyV2BodyKey =
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
  | 'PLAY_PAUSE'
  | 'MENU'
  | 'NUM_0'
  | 'NUM_1'
  | 'NUM_2'
  | 'NUM_3'
  | 'NUM_4'
  | 'NUM_5'
  | 'NUM_6'
  | 'NUM_7'
  | 'NUM_8'
  | 'NUM_9'
  | 'MEDIA_NEXT'
  | 'MEDIA_PREVIOUS'
  | 'INPUT';
export type TvKeyV2BodyDirection = 'SHORT' | 'START_LONG' | 'END_LONG';

/**
 * API para agente: pressionar uma tecla da TV, com opção de pressão curta ou longa. Convive com tv.key.v1.
 */
export interface TvKeyV2Message {
  v: 1;
  id: string;
  type: 'tv.key.v2';
  source: string;
  target: string;
  ts: string;
  correlationId: string | null;
  body: TvKeyV2Body;
}
export interface TvKeyV2Body {
  key: TvKeyV2BodyKey;
  direction?: TvKeyV2BodyDirection;
}
