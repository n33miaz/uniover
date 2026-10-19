/* GERADO por `npm --prefix contracts run generate` — não editar. */

export type TvWatchdogV1BodyKind =
  'port_closed' | 'repair_started' | 'repaired' | 'repair_failed' | 'adb_unreachable' | 'recovered';
export type TvWatchdogV1BodySeverity = 'info' | 'warn' | 'error';

/**
 * Agente para API: evento do vigia que mantém o controle remoto da TV de pé.
 */
export interface TvWatchdogV1Message {
  v: 1;
  id: string;
  type: 'tv.watchdog.v1';
  source: string;
  target: string;
  ts: string;
  correlationId: string | null;
  body: TvWatchdogV1Body;
}
export interface TvWatchdogV1Body {
  kind: TvWatchdogV1BodyKind;
  severity: TvWatchdogV1BodySeverity;
  detail: string;
  attempts: number;
  at: string;
}
