/* GERADO por `npm --prefix contracts run generate` — não editar. */

/**
 * Agente para API: estatísticas de desempenho e medição da captura de tela ('s.stat'), enviadas quando há marca de medição ativa no canal WebRTC ('screen').
 */
export interface PcScreenStatV1Message {
  v: 1;
  id: string;
  type: 'pc.screen.stat.v1';
  source: string;
  target: string;
  ts: string;
  correlationId: string | null;
  body: PcScreenStatV1Body;
}
export interface PcScreenStatV1Body {
  k: 's.stat';
  bytes: number;
  cpu: number | null;
  privateMB: number;
}
