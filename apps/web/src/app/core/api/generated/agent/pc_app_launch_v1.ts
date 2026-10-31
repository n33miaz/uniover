/* GERADO por `npm --prefix contracts run generate` — não editar. */

/**
 * API para agente: abrir um app favorito do PC. O corpo leva só o identificador da lista que o próprio agente publicou em `pc.apps.v1`; o caminho do programa nunca viaja.
 */
export interface PcAppLaunchV1Message {
  v: 1;
  id: string;
  type: 'pc.app.launch.v1';
  source: string;
  target: string;
  ts: string;
  correlationId: string | null;
  body: PcAppLaunchV1Body;
}
export interface PcAppLaunchV1Body {
  appId: string;
}
