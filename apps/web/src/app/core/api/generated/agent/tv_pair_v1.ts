/* GERADO por `npm --prefix contracts run generate` — não editar. */

/**
 * API para agente: pareamento da Android TV, em dois passos e só por pedido do dono. Sem 'code': o agente pede o pareamento e a TV mostra na tela um código de 6 caracteres (0-9 e A-F); responde logo com command.result.v1 (ok: o código está na tela; erro: tv_unreachable, pair_failed). Com 'code': o código digitado; o agente conclui o pareamento e responde com command.result.v1 (ok: pareada, e o estado not_paired some; erro: pair_not_started, invalid_code, pair_closed, pair_failed). O código vale poucos minutos, nunca aparece em registro, auditoria nem mensagem de erro, e o agente nunca inicia o pareamento sozinho.
 */
export interface TvPairV1Message {
  v: 1;
  id: string;
  type: 'tv.pair.v1';
  source: string;
  target: string;
  ts: string;
  correlationId: string | null;
  body: TvPairV1Body;
}
export interface TvPairV1Body {
  code?: string;
}
