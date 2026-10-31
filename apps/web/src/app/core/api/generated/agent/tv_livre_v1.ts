/* GERADO por `npm --prefix contracts run generate` — não editar. */

/**
 * status: lê o estado. install: instala ou atualiza o launcher (não o define como padrão). set-home: define-o como padrão na ordem segura. restore: Voltar ao Original. apply: grava a configuração (configJson). set-apps: desativa ou reativa apps (reversível). sleep: abre o Modo Dormir.
 */
export type TvLivreV1BodyAction =
  'status' | 'install' | 'set-home' | 'restore' | 'apply' | 'set-apps' | 'sleep';

/**
 * API para agente: o módulo TV Livre (launcher próprio da TV Android). Cada `action` é um passo isolado e reversível; nada roda sozinho. O agente responde com command.result.v1 e, antes dele, com tv.livre.state.v1 (o estado depois da ação).
 */
export interface TvLivreV1Message {
  v: 1;
  id: string;
  type: 'tv.livre.v1';
  source: string;
  target: string;
  ts: string;
  correlationId: string | null;
  body: TvLivreV1Body;
}
export interface TvLivreV1Body {
  requestId: string;
  action: TvLivreV1BodyAction;
  /**
   * apply: o número que só cresce (campo revision da configuração do launcher).
   */
  revision?: number;
  /**
   * apply: a configuração do launcher (contracts/tv-launcher/config.v1.schema.json) sem `schema`, `revision` nem o nome da foto, que o agente acrescenta.
   */
  configJson?: string;
  photoId?: string;
  /**
   * set-home: depois de verificar a home nova, desativa o launcher de fábrica (reversível). Padrão: não.
   */
  disableFactory?: boolean;
  /**
   * restore: depois de voltar e verificar, desinstala o launcher. Padrão: sim.
   */
  uninstall?: boolean;
  /**
   * set-apps: pacotes a desativar (pm disable-user). Pacotes protegidos são recusados.
   *
   * @maxItems 64
   */
  disable?: string[];
  /**
   * set-apps: pacotes a reativar.
   *
   * @maxItems 64
   */
  enable?: string[];
}
