/* GERADO por `npm --prefix contracts run generate` — não editar. */

/**
 * API para agente: procura, na rede local do computador, as TVs compatíveis. O agente manda tv.discovery.v1 (com este requestId) e depois o command.result.v1 do mesmo comando; nada é enviado às TVs achadas além da leitura de identificação.
 */
export interface TvDiscoverV1Message {
  v: 1;
  id: string;
  type: 'tv.discover.v1';
  source: string;
  target: string;
  ts: string;
  correlationId: string | null;
  body: TvDiscoverV1Body;
}
export interface TvDiscoverV1Body {
  requestId: string;
}
