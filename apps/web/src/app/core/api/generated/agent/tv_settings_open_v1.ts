/* GERADO por `npm --prefix contracts run generate` — não editar. */

export type TvSettingsOpenV1BodyScreen = 'WIFI' | 'SETTINGS';

/**
 * API para agente: abrir na TV uma tela de configurações de uma lista fechada (WIFI: rede; SETTINGS: configurações). Só é enviada a agente que declara a capacidade tv.settings.open.v1 e só quando a pessoa toca no botão; o corpo nunca leva uma ação livre.
 */
export interface TvSettingsOpenV1Message {
  v: 1;
  id: string;
  type: 'tv.settings.open.v1';
  source: string;
  target: string;
  ts: string;
  correlationId: string | null;
  body: TvSettingsOpenV1Body;
}
export interface TvSettingsOpenV1Body {
  screen: TvSettingsOpenV1BodyScreen;
}
