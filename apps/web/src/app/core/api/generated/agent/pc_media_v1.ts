/* GERADO por `npm --prefix contracts run generate` — não editar. */

export type PcMediaV1BodyAction =
  'PLAY_PAUSE' | 'NEXT' | 'PREVIOUS' | 'STOP' | 'VOLUME_UP' | 'VOLUME_DOWN' | 'MUTE';

/**
 * API para agente: tecla de mídia do Windows (tocar/pausar, faixa, volume, mudo). `steps` repete o volume (1 a 10, padrão 1). `seq` (opcional) numera os pedidos de entrada pela nuvem em ordem crescente (um contador só para o clique, a tecla, o texto e a mídia, durante a vida da página; o movimento tem a numeração própria dele): o agente o compara com o último número que o app declara no canal direto para saber se um pedido da nuvem é anterior à troca de caminho (e por isso não fecha o canal) ou é novo. A API só o repassa a um agente que declara `pc.rtc.v1`.
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
  seq?: number;
}
