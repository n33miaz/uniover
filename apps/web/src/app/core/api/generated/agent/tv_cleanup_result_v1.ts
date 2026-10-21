/* GERADO por `npm --prefix contracts run generate` — não editar. */

/**
 * Agente para API: o que a limpeza da TV fez. Sai antes do command.result.v1 do mesmo comando (correlationId = id do comando) e repete o requestId de tv.cleanup.v1. Só existe quando a limpeza rodou; se o ADB não respondeu, o agente só manda command.result.v1 com erro.
 */
export interface TvCleanupResultV1Message {
  v: 1;
  id: string;
  type: 'tv.cleanup.result.v1';
  source: string;
  target: string;
  ts: string;
  correlationId: string;
  body: TvCleanupResultV1Body;
}
export interface TvCleanupResultV1Body {
  requestId: string;
  closedApps: number;
  memoryBeforeMb: number | null;
  memoryAfterMb: number | null;
  freedMb: number | null;
  /**
   * @maxItems 50
   */
  failedSteps: string[];
  at: string;
}
