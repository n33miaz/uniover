/* GERADO por `npm --prefix contracts run generate` — não editar. */

/**
 * API para agente: preferências da limpeza automática da TV.
 */
export interface TvCleanupConfigV1Message {
  v: 1;
  id: string;
  type: 'tv.cleanup.config.v1';
  source: string;
  target: string;
  ts: string;
  correlationId: null;
  body: TvCleanupConfigV1Body;
}
export interface TvCleanupConfigV1Body {
  lightEnabled: boolean;
  deepEnabled: boolean;
  deepThresholdMb: number;
  closeBackgroundApps?: boolean;
  maintenanceEnabled?: boolean;
  focusEnabled?: boolean;
  focusClosesBackground?: boolean;
  shortAnimationsEnabled?: boolean;
  /**
   * @maxItems 100
   */
  restrictedPackages?: string[];
}
