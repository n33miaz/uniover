/* eslint-disable */
/* GERADO por `npm --prefix contracts run generate` — não editar. */

/**
 * API para agente: desliga a TV somente depois de ler que ela está ligada e nunca a liga. Só é enviada a agente que declara a capacidade tv.power.off.v1. O resultado é command.result.v1: ok=true significa off; ok=false usa em error.code um destes: already_off, uncertain, offline ou failed.
 */
export interface TvPowerOffV1Message {
  v: 1;
  id: string;
  type: 'tv.power.off.v1';
  source: string;
  target: string;
  ts: string;
  correlationId: string | null;
  body: TvPowerOffV1Body;
}
export interface TvPowerOffV1Body {}
