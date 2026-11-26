/* GERADO por `npm --prefix contracts run generate` — não editar. */

export type PcScreenStateV1BodyState = 'ok' | 'locked' | 'elevated';

/**
 * Agente para API: estado do desktop do PC ('s.state'), enviado no canal WebRTC ('screen'). 'ok' é área de trabalho normal; 'locked' é estação bloqueada ou tela de logon/UAC; 'elevated' indica janela de administrador em foco.
 */
export interface PcScreenStateV1Message {
  v: 1;
  id: string;
  type: 'pc.screen.state.v1';
  source: string;
  target: string;
  ts: string;
  correlationId: string | null;
  body: PcScreenStateV1Body;
}
export interface PcScreenStateV1Body {
  k: 's.state';
  state: PcScreenStateV1BodyState;
}
