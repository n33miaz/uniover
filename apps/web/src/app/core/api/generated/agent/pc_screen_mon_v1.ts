/* GERADO por `npm --prefix contracts run generate` — não editar. */

/**
 * PC para app: lista de monitores ('s.mon') no canal de dados WebRTC 'screen'. O objeto vai nu, sem envelope. 'monitors' traz de 1 a 16 monitores com id estável na sessão, dimensões e posição física no desktop virtual. 'layout' é a impressão do arranjo inteiro (CRC-32 dos monitores, 0 a 4294967295); pode ser null, e um PC anterior ao toque omite o campo.
 */
export interface PcScreenMonV1Message {
  k: 's.mon';
  /**
   * @minItems 1
   * @maxItems 16
   */
  monitors:
    | [PcScreenMonV1MonitorsItem]
    | [PcScreenMonV1MonitorsItem, PcScreenMonV1MonitorsItem]
    | [PcScreenMonV1MonitorsItem, PcScreenMonV1MonitorsItem, PcScreenMonV1MonitorsItem]
    | [
        PcScreenMonV1MonitorsItem,
        PcScreenMonV1MonitorsItem,
        PcScreenMonV1MonitorsItem,
        PcScreenMonV1MonitorsItem,
      ]
    | [
        PcScreenMonV1MonitorsItem,
        PcScreenMonV1MonitorsItem,
        PcScreenMonV1MonitorsItem,
        PcScreenMonV1MonitorsItem,
        PcScreenMonV1MonitorsItem,
      ]
    | [
        PcScreenMonV1MonitorsItem,
        PcScreenMonV1MonitorsItem,
        PcScreenMonV1MonitorsItem,
        PcScreenMonV1MonitorsItem,
        PcScreenMonV1MonitorsItem,
        PcScreenMonV1MonitorsItem,
      ]
    | [
        PcScreenMonV1MonitorsItem,
        PcScreenMonV1MonitorsItem,
        PcScreenMonV1MonitorsItem,
        PcScreenMonV1MonitorsItem,
        PcScreenMonV1MonitorsItem,
        PcScreenMonV1MonitorsItem,
        PcScreenMonV1MonitorsItem,
      ]
    | [
        PcScreenMonV1MonitorsItem,
        PcScreenMonV1MonitorsItem,
        PcScreenMonV1MonitorsItem,
        PcScreenMonV1MonitorsItem,
        PcScreenMonV1MonitorsItem,
        PcScreenMonV1MonitorsItem,
        PcScreenMonV1MonitorsItem,
        PcScreenMonV1MonitorsItem,
      ]
    | [
        PcScreenMonV1MonitorsItem,
        PcScreenMonV1MonitorsItem,
        PcScreenMonV1MonitorsItem,
        PcScreenMonV1MonitorsItem,
        PcScreenMonV1MonitorsItem,
        PcScreenMonV1MonitorsItem,
        PcScreenMonV1MonitorsItem,
        PcScreenMonV1MonitorsItem,
        PcScreenMonV1MonitorsItem,
      ]
    | [
        PcScreenMonV1MonitorsItem,
        PcScreenMonV1MonitorsItem,
        PcScreenMonV1MonitorsItem,
        PcScreenMonV1MonitorsItem,
        PcScreenMonV1MonitorsItem,
        PcScreenMonV1MonitorsItem,
        PcScreenMonV1MonitorsItem,
        PcScreenMonV1MonitorsItem,
        PcScreenMonV1MonitorsItem,
        PcScreenMonV1MonitorsItem,
      ]
    | [
        PcScreenMonV1MonitorsItem,
        PcScreenMonV1MonitorsItem,
        PcScreenMonV1MonitorsItem,
        PcScreenMonV1MonitorsItem,
        PcScreenMonV1MonitorsItem,
        PcScreenMonV1MonitorsItem,
        PcScreenMonV1MonitorsItem,
        PcScreenMonV1MonitorsItem,
        PcScreenMonV1MonitorsItem,
        PcScreenMonV1MonitorsItem,
        PcScreenMonV1MonitorsItem,
      ]
    | [
        PcScreenMonV1MonitorsItem,
        PcScreenMonV1MonitorsItem,
        PcScreenMonV1MonitorsItem,
        PcScreenMonV1MonitorsItem,
        PcScreenMonV1MonitorsItem,
        PcScreenMonV1MonitorsItem,
        PcScreenMonV1MonitorsItem,
        PcScreenMonV1MonitorsItem,
        PcScreenMonV1MonitorsItem,
        PcScreenMonV1MonitorsItem,
        PcScreenMonV1MonitorsItem,
        PcScreenMonV1MonitorsItem,
      ]
    | [
        PcScreenMonV1MonitorsItem,
        PcScreenMonV1MonitorsItem,
        PcScreenMonV1MonitorsItem,
        PcScreenMonV1MonitorsItem,
        PcScreenMonV1MonitorsItem,
        PcScreenMonV1MonitorsItem,
        PcScreenMonV1MonitorsItem,
        PcScreenMonV1MonitorsItem,
        PcScreenMonV1MonitorsItem,
        PcScreenMonV1MonitorsItem,
        PcScreenMonV1MonitorsItem,
        PcScreenMonV1MonitorsItem,
        PcScreenMonV1MonitorsItem,
      ]
    | [
        PcScreenMonV1MonitorsItem,
        PcScreenMonV1MonitorsItem,
        PcScreenMonV1MonitorsItem,
        PcScreenMonV1MonitorsItem,
        PcScreenMonV1MonitorsItem,
        PcScreenMonV1MonitorsItem,
        PcScreenMonV1MonitorsItem,
        PcScreenMonV1MonitorsItem,
        PcScreenMonV1MonitorsItem,
        PcScreenMonV1MonitorsItem,
        PcScreenMonV1MonitorsItem,
        PcScreenMonV1MonitorsItem,
        PcScreenMonV1MonitorsItem,
        PcScreenMonV1MonitorsItem,
      ]
    | [
        PcScreenMonV1MonitorsItem,
        PcScreenMonV1MonitorsItem,
        PcScreenMonV1MonitorsItem,
        PcScreenMonV1MonitorsItem,
        PcScreenMonV1MonitorsItem,
        PcScreenMonV1MonitorsItem,
        PcScreenMonV1MonitorsItem,
        PcScreenMonV1MonitorsItem,
        PcScreenMonV1MonitorsItem,
        PcScreenMonV1MonitorsItem,
        PcScreenMonV1MonitorsItem,
        PcScreenMonV1MonitorsItem,
        PcScreenMonV1MonitorsItem,
        PcScreenMonV1MonitorsItem,
        PcScreenMonV1MonitorsItem,
      ]
    | [
        PcScreenMonV1MonitorsItem,
        PcScreenMonV1MonitorsItem,
        PcScreenMonV1MonitorsItem,
        PcScreenMonV1MonitorsItem,
        PcScreenMonV1MonitorsItem,
        PcScreenMonV1MonitorsItem,
        PcScreenMonV1MonitorsItem,
        PcScreenMonV1MonitorsItem,
        PcScreenMonV1MonitorsItem,
        PcScreenMonV1MonitorsItem,
        PcScreenMonV1MonitorsItem,
        PcScreenMonV1MonitorsItem,
        PcScreenMonV1MonitorsItem,
        PcScreenMonV1MonitorsItem,
        PcScreenMonV1MonitorsItem,
        PcScreenMonV1MonitorsItem,
      ];
  layout?: number | null;
}
export interface PcScreenMonV1MonitorsItem {
  id: number;
  primary: boolean;
  width: number;
  height: number;
  x?: number;
  y?: number;
  left?: number;
  top?: number;
}
