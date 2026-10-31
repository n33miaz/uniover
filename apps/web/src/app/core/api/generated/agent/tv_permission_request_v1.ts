/* eslint-disable */
/* GERADO por `npm --prefix contracts run generate` — não editar. */

/**
 * API para agente: pede à TV Samsung a permissão do UniOver (o aviso 'Permitir' na tela da TV). O agente responde logo com command.result.v1 (ok: o aviso foi pedido; erro: unsupported, tv_unreachable, permission_in_progress) e, quando a pessoa aceita, recusa ou o tempo acaba, manda tv.permission.v1. Só acontece por este pedido: o agente nunca pede a permissão sozinho.
 */
export interface TvPermissionRequestV1Message {
  v: 1;
  id: string;
  type: 'tv.permission.request.v1';
  source: string;
  target: string;
  ts: string;
  correlationId: string | null;
  body: TvPermissionRequestV1Body;
}
export interface TvPermissionRequestV1Body {}
