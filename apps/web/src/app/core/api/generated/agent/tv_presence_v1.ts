/* eslint-disable */
/* GERADO por `npm --prefix contracts run generate` — não editar. */

/**
 * API para agente: alguém está diante da tela da TV no app agora (tela visível). Só este sinal, e não o tipo de comando, deixa o agente abrir uma conexão ADB nova nos 60 segundos seguintes.
 */
export interface TvPresenceV1Message {
  v: 1;
  id: string;
  type: 'tv.presence.v1';
  source: string;
  target: string;
  ts: string;
  correlationId: string | null;
  body: TvPresenceV1Body;
}
export interface TvPresenceV1Body {}
