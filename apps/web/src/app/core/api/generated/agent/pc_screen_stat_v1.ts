/* GERADO por `npm --prefix contracts run generate` — não editar. */

/**
 * PC para app: medições da captura ('s.stat') no canal de dados WebRTC 'screen', enviadas quando o pedido traz marca de medição. O objeto vai nu, sem envelope.
 */
export interface PcScreenStatV1Message {
  k: 's.stat';
  bytes: number;
  cpu: number | null;
  privateMB: number;
}
