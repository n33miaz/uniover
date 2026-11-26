/* GERADO por `npm --prefix contracts run generate` — não editar. */

/**
 * Agente para API: lista de monitores do PC anunciada no canal de dados WebRTC ('screen'). 'monitors' lista de 1 a 16 monitores com id estável na sessão, dimensões e posição física no desktop virtual. 'layout' é a impressão do arranjo inteiro (CRC-32 dos monitores, 0 a 4294967295) ou null para agente antigo.
 */
export interface PcScreenMonV1Message {
  v: 1;
  id: string;
  type: 'pc.screen.mon.v1';
  source: string;
  target: string;
  ts: string;
  correlationId: string | null;
  body: PcScreenMonV1Body;
}
export interface PcScreenMonV1Body {
  k: 's.mon';
  /**
   * @minItems 1
   * @maxItems 16
   */
  monitors:
    | [PcScreenMonV1BodyMonitorsItem]
    | [PcScreenMonV1BodyMonitorsItem, PcScreenMonV1BodyMonitorsItem]
    | [PcScreenMonV1BodyMonitorsItem, PcScreenMonV1BodyMonitorsItem, PcScreenMonV1BodyMonitorsItem]
    | [
        PcScreenMonV1BodyMonitorsItem,
        PcScreenMonV1BodyMonitorsItem,
        PcScreenMonV1BodyMonitorsItem,
        PcScreenMonV1BodyMonitorsItem,
      ]
    | [
        PcScreenMonV1BodyMonitorsItem,
        PcScreenMonV1BodyMonitorsItem,
        PcScreenMonV1BodyMonitorsItem,
        PcScreenMonV1BodyMonitorsItem,
        PcScreenMonV1BodyMonitorsItem,
      ]
    | [
        PcScreenMonV1BodyMonitorsItem,
        PcScreenMonV1BodyMonitorsItem,
        PcScreenMonV1BodyMonitorsItem,
        PcScreenMonV1BodyMonitorsItem,
        PcScreenMonV1BodyMonitorsItem,
        PcScreenMonV1BodyMonitorsItem,
      ]
    | [
        PcScreenMonV1BodyMonitorsItem,
        PcScreenMonV1BodyMonitorsItem,
        PcScreenMonV1BodyMonitorsItem,
        PcScreenMonV1BodyMonitorsItem,
        PcScreenMonV1BodyMonitorsItem,
        PcScreenMonV1BodyMonitorsItem,
        PcScreenMonV1BodyMonitorsItem,
      ]
    | [
        PcScreenMonV1BodyMonitorsItem,
        PcScreenMonV1BodyMonitorsItem,
        PcScreenMonV1BodyMonitorsItem,
        PcScreenMonV1BodyMonitorsItem,
        PcScreenMonV1BodyMonitorsItem,
        PcScreenMonV1BodyMonitorsItem,
        PcScreenMonV1BodyMonitorsItem,
        PcScreenMonV1BodyMonitorsItem,
      ]
    | [
        PcScreenMonV1BodyMonitorsItem,
        PcScreenMonV1BodyMonitorsItem,
        PcScreenMonV1BodyMonitorsItem,
        PcScreenMonV1BodyMonitorsItem,
        PcScreenMonV1BodyMonitorsItem,
        PcScreenMonV1BodyMonitorsItem,
        PcScreenMonV1BodyMonitorsItem,
        PcScreenMonV1BodyMonitorsItem,
        PcScreenMonV1BodyMonitorsItem,
      ]
    | [
        PcScreenMonV1BodyMonitorsItem,
        PcScreenMonV1BodyMonitorsItem,
        PcScreenMonV1BodyMonitorsItem,
        PcScreenMonV1BodyMonitorsItem,
        PcScreenMonV1BodyMonitorsItem,
        PcScreenMonV1BodyMonitorsItem,
        PcScreenMonV1BodyMonitorsItem,
        PcScreenMonV1BodyMonitorsItem,
        PcScreenMonV1BodyMonitorsItem,
        PcScreenMonV1BodyMonitorsItem,
      ]
    | [
        PcScreenMonV1BodyMonitorsItem,
        PcScreenMonV1BodyMonitorsItem,
        PcScreenMonV1BodyMonitorsItem,
        PcScreenMonV1BodyMonitorsItem,
        PcScreenMonV1BodyMonitorsItem,
        PcScreenMonV1BodyMonitorsItem,
        PcScreenMonV1BodyMonitorsItem,
        PcScreenMonV1BodyMonitorsItem,
        PcScreenMonV1BodyMonitorsItem,
        PcScreenMonV1BodyMonitorsItem,
        PcScreenMonV1BodyMonitorsItem,
      ]
    | [
        PcScreenMonV1BodyMonitorsItem,
        PcScreenMonV1BodyMonitorsItem,
        PcScreenMonV1BodyMonitorsItem,
        PcScreenMonV1BodyMonitorsItem,
        PcScreenMonV1BodyMonitorsItem,
        PcScreenMonV1BodyMonitorsItem,
        PcScreenMonV1BodyMonitorsItem,
        PcScreenMonV1BodyMonitorsItem,
        PcScreenMonV1BodyMonitorsItem,
        PcScreenMonV1BodyMonitorsItem,
        PcScreenMonV1BodyMonitorsItem,
        PcScreenMonV1BodyMonitorsItem,
      ]
    | [
        PcScreenMonV1BodyMonitorsItem,
        PcScreenMonV1BodyMonitorsItem,
        PcScreenMonV1BodyMonitorsItem,
        PcScreenMonV1BodyMonitorsItem,
        PcScreenMonV1BodyMonitorsItem,
        PcScreenMonV1BodyMonitorsItem,
        PcScreenMonV1BodyMonitorsItem,
        PcScreenMonV1BodyMonitorsItem,
        PcScreenMonV1BodyMonitorsItem,
        PcScreenMonV1BodyMonitorsItem,
        PcScreenMonV1BodyMonitorsItem,
        PcScreenMonV1BodyMonitorsItem,
        PcScreenMonV1BodyMonitorsItem,
      ]
    | [
        PcScreenMonV1BodyMonitorsItem,
        PcScreenMonV1BodyMonitorsItem,
        PcScreenMonV1BodyMonitorsItem,
        PcScreenMonV1BodyMonitorsItem,
        PcScreenMonV1BodyMonitorsItem,
        PcScreenMonV1BodyMonitorsItem,
        PcScreenMonV1BodyMonitorsItem,
        PcScreenMonV1BodyMonitorsItem,
        PcScreenMonV1BodyMonitorsItem,
        PcScreenMonV1BodyMonitorsItem,
        PcScreenMonV1BodyMonitorsItem,
        PcScreenMonV1BodyMonitorsItem,
        PcScreenMonV1BodyMonitorsItem,
        PcScreenMonV1BodyMonitorsItem,
      ]
    | [
        PcScreenMonV1BodyMonitorsItem,
        PcScreenMonV1BodyMonitorsItem,
        PcScreenMonV1BodyMonitorsItem,
        PcScreenMonV1BodyMonitorsItem,
        PcScreenMonV1BodyMonitorsItem,
        PcScreenMonV1BodyMonitorsItem,
        PcScreenMonV1BodyMonitorsItem,
        PcScreenMonV1BodyMonitorsItem,
        PcScreenMonV1BodyMonitorsItem,
        PcScreenMonV1BodyMonitorsItem,
        PcScreenMonV1BodyMonitorsItem,
        PcScreenMonV1BodyMonitorsItem,
        PcScreenMonV1BodyMonitorsItem,
        PcScreenMonV1BodyMonitorsItem,
        PcScreenMonV1BodyMonitorsItem,
      ]
    | [
        PcScreenMonV1BodyMonitorsItem,
        PcScreenMonV1BodyMonitorsItem,
        PcScreenMonV1BodyMonitorsItem,
        PcScreenMonV1BodyMonitorsItem,
        PcScreenMonV1BodyMonitorsItem,
        PcScreenMonV1BodyMonitorsItem,
        PcScreenMonV1BodyMonitorsItem,
        PcScreenMonV1BodyMonitorsItem,
        PcScreenMonV1BodyMonitorsItem,
        PcScreenMonV1BodyMonitorsItem,
        PcScreenMonV1BodyMonitorsItem,
        PcScreenMonV1BodyMonitorsItem,
        PcScreenMonV1BodyMonitorsItem,
        PcScreenMonV1BodyMonitorsItem,
        PcScreenMonV1BodyMonitorsItem,
        PcScreenMonV1BodyMonitorsItem,
      ];
  layout?: number | null;
}
export interface PcScreenMonV1BodyMonitorsItem {
  id: number;
  primary: boolean;
  width: number;
  height: number;
  x?: number;
  y?: number;
  left?: number;
  top?: number;
}
