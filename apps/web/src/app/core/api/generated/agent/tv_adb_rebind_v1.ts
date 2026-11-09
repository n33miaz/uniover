/* eslint-disable */
/* GERADO por `npm --prefix contracts run generate` — não editar. */

/**
 * API para agente: a pessoa disse, no app, que o aparelho que responde agora no endereço da TV é a mesma TV (trocou de Wi-Fi para cabo, por exemplo). O agente refaz o registro da permissão do ADB para o MAC de agora e responde com command.result.v1 (ok; erros adb_identity, adb_unreachable). Não conecta a nada: o pedido de permissão que vem depois é o de sempre (tv.apps.refresh.v1). Só acontece por este pedido: o agente nunca troca o aparelho do registro sozinho.
 */
export interface TvAdbRebindV1Message {
  v: 1;
  id: string;
  type: 'tv.adb.rebind.v1';
  source: string;
  target: string;
  ts: string;
  correlationId: string | null;
  body: TvAdbRebindV1Body;
}
export interface TvAdbRebindV1Body {}
