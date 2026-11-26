/* GERADO por `npm --prefix contracts run generate` — não editar. */

export type PcScreenStateV1State = 'ok' | 'locked' | 'elevated';

/**
 * PC para app: estado do desktop ('s.state') no canal de dados WebRTC 'screen'. O objeto vai nu, sem envelope. 'ok' é a área de trabalho normal; 'locked' é a estação bloqueada ou a tela de logon/UAC; 'elevated' indica janela de administrador em foco.
 */
export interface PcScreenStateV1Message {
  k: 's.state';
  state: PcScreenStateV1State;
}
