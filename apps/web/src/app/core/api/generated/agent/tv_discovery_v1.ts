/* GERADO por `npm --prefix contracts run generate` — não editar. */

export type TvDiscoveryV1BodyTvsItemKind = 'android' | 'samsung';

/**
 * Agente para API: as TVs compatíveis que o agente achou na rede local dele. Sai antes do command.result.v1 de tv.discover.v1 (correlationId = id do comando) e repete o requestId. Nunca leva endereço IP nem MAC: 'id' é opaco e estável (derivado do identificador da TV) e 'controlled' diz se é a TV que este agente já controla.
 */
export interface TvDiscoveryV1Message {
  v: 1;
  id: string;
  type: 'tv.discovery.v1';
  source: string;
  target: string;
  ts: string;
  correlationId: string;
  body: TvDiscoveryV1Body;
}
export interface TvDiscoveryV1Body {
  requestId: string;
  /**
   * @maxItems 50
   */
  tvs: TvDiscoveryV1BodyTvsItem[];
  at: string;
}
export interface TvDiscoveryV1BodyTvsItem {
  id: string;
  kind: TvDiscoveryV1BodyTvsItemKind;
  name: string | null;
  controlled: boolean;
}
