/** Painéis flutuantes da tela da TV. */
export type TvPanelName = 'apps' | 'keyboard';

/**
 * Parâmetro de endereço que abre um painel ao chegar em `/tv` (`/tv?painel=apps`). Existe para os endereços antigos
 * `/tv/apps` e `/tv/teclado`, que agora redirecionam para cá.
 */
export const TV_PANEL_PARAM = 'painel';

/** Valor do parâmetro de cada painel; mantém o nome do endereço antigo. */
export const TV_PANEL_VALUES: Record<TvPanelName, string> = {
  apps: 'apps',
  keyboard: 'teclado',
};

/** Lê o valor do parâmetro e devolve o painel, ou `null` se não for um painel conhecido. */
export function panelFromParam(value: string | null): TvPanelName | null {
  for (const name of Object.keys(TV_PANEL_VALUES) as TvPanelName[]) {
    if (TV_PANEL_VALUES[name] === value) return name;
  }
  return null;
}
