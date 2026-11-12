/* GERADO por `npm --prefix contracts run generate` — não editar. */

export type TvStateV1BodyPower = 'on' | 'off' | 'unknown';
export type TvStateV1BodyConnection =
  'hot' | 'hibernating' | 'disconnected' | 'not_paired' | 'waking';
export type TvStateV1BodyAdbPermission = 'granted' | 'missing' | 'pending';
export type TvStateV1BodyWakeHintsItem = 'screenless_off' | 'replug';

/**
 * Agente para API: estado atual da TV.
 */
export interface TvStateV1Message {
  v: 1;
  id: string;
  type: 'tv.state.v1';
  source: string;
  target: string;
  ts: string;
  correlationId: string | null;
  body: TvStateV1Body;
}
export interface TvStateV1Body {
  power: TvStateV1BodyPower;
  volume: number | null;
  app: string | null;
  connection: TvStateV1BodyConnection;
  adbPermission?: TvStateV1BodyAdbPermission;
  adbPermissionReason?: string;
  /**
   * @minItems 1
   * @maxItems 2
   */
  wakeHints?:
    [TvStateV1BodyWakeHintsItem] | [TvStateV1BodyWakeHintsItem, TvStateV1BodyWakeHintsItem];
}
