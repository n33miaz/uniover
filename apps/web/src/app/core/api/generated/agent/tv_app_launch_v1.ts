/* GERADO por `npm --prefix contracts run generate` — não editar. */

export type TvAppLaunchV1BodyTargetKind = 'package' | 'link';

/**
 * API para agente: abrir um app da TV por pacote Android ou por link (deep link).
 */
export interface TvAppLaunchV1Message {
  v: 1;
  id: string;
  type: 'tv.app.launch.v1';
  source: string;
  target: string;
  ts: string;
  correlationId: string | null;
  body: TvAppLaunchV1Body;
}
export interface TvAppLaunchV1Body {
  target: TvAppLaunchV1BodyTarget;
}
export interface TvAppLaunchV1BodyTarget {
  kind: TvAppLaunchV1BodyTargetKind;
  value: string;
}
