/* GERADO por `npm --prefix contracts run generate` — não editar. */

export type PcMediaStateV1BodyStatus = 'playing' | 'paused' | 'stopped' | 'none';

/**
 * Agente para API: o que o Windows diz estar tocando (`status`: `playing`, `paused`, `stopped` ou `none` quando não há sessão de mídia; `title`, `artist` e `app`, o programa que toca, vazios quando não há faixa) e quando foi lido (`at`). Responde a `pc.media.query.v1`: `correlationId` é o do pedido. O título é conteúdo da pessoa: a API o guarda só em memória, por agente, o devolve em `GET /api/v1/pc/now-playing` e nunca o registra nem o audita. O agente só o manda a uma API que listou `pc.media.state.v1` em `features`.
 */
export interface PcMediaStateV1Message {
  v: 1;
  id: string;
  type: 'pc.media.state.v1';
  source: string;
  target: string;
  ts: string;
  correlationId: string | null;
  body: PcMediaStateV1Body;
}
export interface PcMediaStateV1Body {
  status: PcMediaStateV1BodyStatus;
  title: string;
  artist: string;
  app: string;
  at: string;
}
