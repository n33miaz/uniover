/* GERADO por `npm --prefix contracts run generate` — não editar. */

export type PcMediaV1BodyAction =
  'PLAY_PAUSE' | 'NEXT' | 'PREVIOUS' | 'STOP' | 'VOLUME_UP' | 'VOLUME_DOWN' | 'MUTE';

/**
 * API para agente: tecla de mídia do Windows (tocar/pausar, faixa, volume, mudo). `steps` repete o volume (1 a 10, padrão 1).
 */
export interface PcMediaV1Message {
  v: 1;
  id: string;
  type: 'pc.media.v1';
  source: string;
  target: string;
  ts: string;
  correlationId: string | null;
  body: PcMediaV1Body;
}
export interface PcMediaV1Body {
  action: PcMediaV1BodyAction;
  steps?: number;
}
