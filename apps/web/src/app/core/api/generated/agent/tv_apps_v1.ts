/* GERADO por `npm --prefix contracts run generate` — não editar. */

/**
 * Agente para API: lista de apps instalados na TV.
 */
export interface TvAppsV1Message {
  v: 1;
  id: string;
  type: 'tv.apps.v1';
  source: string;
  target: string;
  ts: string;
  correlationId: string | null;
  body: TvAppsV1Body;
}
export interface TvAppsV1Body {
  /**
   * @maxItems 500
   */
  apps: TvAppsV1BodyAppsItem[];
  at: string;
}
export interface TvAppsV1BodyAppsItem {
  package: string;
  label: string | null;
}
