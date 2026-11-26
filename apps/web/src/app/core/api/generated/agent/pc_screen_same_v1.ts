/* GERADO por `npm --prefix contracts run generate` — não editar. */

/**
 * Agente para API: aviso de que o quadro atual da tela tem o mesmo CRC-32 do anterior ('s.same'), evitando reenvio de imagem idêntica pelo canal WebRTC ('screen').
 */
export interface PcScreenSameV1Message {
  v: 1;
  id: string;
  type: 'pc.screen.same.v1';
  source: string;
  target: string;
  ts: string;
  correlationId: string | null;
  body: PcScreenSameV1Body;
}
export interface PcScreenSameV1Body {
  k: 's.same';
  crc: number;
}
