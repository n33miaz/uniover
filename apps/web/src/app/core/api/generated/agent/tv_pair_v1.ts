/* GERADO por `npm --prefix contracts run generate` — não editar. */

/**
 * API para agente: pareamento da Android TV, em passos e só por pedido do dono. Sem 'code' nem 'cancel': o agente pede o pareamento e a TV mostra na tela um código de 6 caracteres (0-9 e A-F); responde logo com command.result.v1 (ok: o código está na tela; erro: tv_unreachable, pair_failed). Com 'code': o código digitado; o agente responde assim que a TV aceita o par (ok) e só então reabre a sessão, então o resultado da abertura chega pelo estado (tv.state.v1: o not_paired some, ou continua se a TV recusar de novo); erros: pair_not_started, pair_timeout, invalid_code, pair_closed, pair_failed, pair_busy. Com 'cancel' (true): o app fechou a folha; o agente larga o pareamento que esperava o código (a TV o tira da tela); responde ok mesmo sem nada pendente. 'cancel' e 'code' não vão juntos (a API recusa). O código vale poucos minutos, nunca aparece em registro, auditoria nem mensagem de erro, e o agente nunca inicia o pareamento sozinho.
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
  cancel?: true;
}
