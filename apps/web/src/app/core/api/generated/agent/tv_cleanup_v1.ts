/* GERADO por `npm --prefix contracts run generate` — não editar. */

export type TvCleanupV1BodyMode = 'light' | 'deep' | 'manual';

/**
 * API para agente: fecha os apps abertos na TV e libera memória pelo ADB, sem derrubar a conexão do controle remoto. O agente responde com command.result.v1 e, antes dele, com tv.cleanup.result.v1 (que devolve o requestId).
 */
export interface TvCleanupV1Message {
  v: 1;
  id: string;
  type: 'tv.cleanup.v1';
  source: string;
  target: string;
  ts: string;
  correlationId: string | null;
  body: TvCleanupV1Body;
}
export interface TvCleanupV1Body {
  requestId: string;
  mode?: TvCleanupV1BodyMode;
  foregroundPackage?: string;
}
