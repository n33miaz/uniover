/* GERADO por `npm --prefix contracts run generate` — não editar. */

/**
 * Agente para API: o estado do TV Livre na TV, enviado depois de cada ação (antes do command.result.v1). correlationId é o id do comando.
 */
export interface TvLivreStateV1Message {
  v: 1;
  id: string;
  type: 'tv.livre.state.v1';
  source: string;
  target: string;
  ts: string;
  correlationId: string | null;
  body: TvLivreStateV1Body;
}
export interface TvLivreStateV1Body {
  requestId: string;
  /**
   * A TV é Android TV ou Google TV com Android 9 ou mais. Falso: o módulo some da tela.
   */
  supported: boolean;
  sdk?: number;
  installed: boolean;
  /**
   * versionName do launcher instalado.
   */
  version?: string;
  /**
   * O launcher é a tela inicial padrão agora.
   */
  isHome: boolean;
  /**
   * Componente do launcher de fábrica guardado (pacote/atividade).
   */
  factoryLauncher?: string;
  /**
   * Pacotes que o agente desativou (e que o Voltar ao Original reativa).
   *
   * @maxItems 300
   */
  disabledPackages?: string[];
  /**
   * @maxItems 300
   */
  apps: TvLivreStateV1BodyAppsItem[];
  at: string;
}
export interface TvLivreStateV1BodyAppsItem {
  package: string;
  /**
   * App de sistema que nunca foi atualizado.
   */
  factory: boolean;
  disabled: boolean;
}
