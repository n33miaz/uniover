/* GERADO por `npm --prefix contracts run generate` — não editar. */

export type TvKeyV3BodyKey =
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
  | 'INPUT'
  | 'INFO'
  | 'GUIDE'
  | 'TOOLS'
  | 'CHANNEL_LIST'
  | 'PREVIOUS_CHANNEL'
  | 'EXIT'
  | 'PLAY'
  | 'PAUSE'
  | 'STOP'
  | 'REWIND'
  | 'FAST_FORWARD'
  | 'RED'
  | 'GREEN'
  | 'YELLOW'
  | 'BLUE'
  | 'SUBTITLE'
  | 'ASPECT'
  | 'SLEEP'
  | 'E_MANUAL';
export type TvKeyV3BodyDirection = 'SHORT' | 'START_LONG' | 'END_LONG';

/**
 * API para agente: pressionar uma tecla da TV, com opção de pressão curta ou longa. Convive com tv.key.v1 e tv.key.v2: a API só usa esta para as teclas que as outras não têm.
 */
export interface TvKeyV3Message {
  v: 1;
  id: string;
  type: 'tv.key.v3';
  source: string;
  target: string;
  ts: string;
  correlationId: string | null;
  body: TvKeyV3Body;
}
export interface TvKeyV3Body {
  key: TvKeyV3BodyKey;
  direction?: TvKeyV3BodyDirection;
}
