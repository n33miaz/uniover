/* GERADO por `npm --prefix contracts run generate` — não editar. */

export type TvAppsV2BodyAppsItemIconMime = 'image/png' | 'image/webp';

/**
 * Agente para API: lista de apps da TV com o ícone de cada um (imagem pequena em base64). A lista é sempre completa; o ícone é opcional por app e, quando falta, a API mantém o que já guarda. Como o transporte limita o tamanho de cada mensagem, o agente pode mandar a mesma lista várias vezes, cada uma levando só uma parte dos ícones. tv.apps.v1 continua válido.
 */
export interface TvAppsV2Message {
  v: 1;
  id: string;
  type: 'tv.apps.v2';
  source: string;
  target: string;
  ts: string;
  correlationId: string | null;
  body: TvAppsV2Body;
}
export interface TvAppsV2Body {
  /**
   * @maxItems 500
   */
  apps: TvAppsV2BodyAppsItem[];
  at: string;
}
export interface TvAppsV2BodyAppsItem {
  package: string;
  label: string | null;
  icon?: TvAppsV2BodyAppsItemIcon;
}
export interface TvAppsV2BodyAppsItemIcon {
  mime: TvAppsV2BodyAppsItemIconMime;
  /**
   * Imagem em base64 padrão com preenchimento. No máximo 32768 bytes (43692 caracteres).
   */
  data: string;
}
