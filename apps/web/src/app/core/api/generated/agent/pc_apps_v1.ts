/* GERADO por `npm --prefix contracts run generate` — não editar. */

/**
 * Agente para API: os apps favoritos que este PC deixa abrir pelo app (identificador estável e nome). A lista é sempre completa; lista vazia limpa os favoritos.
 */
export interface PcAppsV1Message {
  v: 1;
  id: string;
  type: 'pc.apps.v1';
  source: string;
  target: string;
  ts: string;
  correlationId: string | null;
  body: PcAppsV1Body;
}
export interface PcAppsV1Body {
  /**
   * @maxItems 24
   */
  apps: PcAppsV1BodyAppsItem[];
  at: string;
}
export interface PcAppsV1BodyAppsItem {
  id: string;
  label: string;
}
