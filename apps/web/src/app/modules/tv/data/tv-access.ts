import { Injectable, computed, inject } from '@angular/core';
import { userCan } from '../../../core/session/access';
import { SessionState } from '../../../core/session/session-state';

/**
 * O que a pessoa pode fazer na TV, um signal para cada permissão da API (a mesma que ela confere em cada rota). A tela
 * consulta só aqui, em vez de cada componente reler a lista: o que a pessoa não pode, ela não vê, e o controle nunca faz
 * uma chamada que o servidor recusaria. Reage na hora quando a sessão traz outra lista de permissões.
 *
 * Toda ação da TV exige ver a TV (a API recusa a lista que traga uma sem a outra, e a conferência das rotas também),
 * então `view` é parte de todas elas.
 */
@Injectable({ providedIn: 'root' })
export class TvAccess {
  private readonly session = inject(SessionState);

  /** Ver o estado, os atalhos e o fluxo ao vivo (`module:tv`): sem isso a tela da TV não faz chamada nenhuma. */
  readonly view = this.grant('module:tv');
  /** Teclas, texto, acordar e limpar a TV (`tv:control`). */
  readonly control = this.action('tv:control');
  /** Desligar a TV (`tv:power`). */
  readonly power = this.action('tv:power');
  /** Abrir apps e atualizar a lista deles (`tv:launch`). */
  readonly launch = this.action('tv:launch');
  /** Renomear, fixar e reordenar os atalhos (`tv:edit-shortcuts`). */
  readonly editShortcuts = this.action('tv:edit-shortcuts');
  /** Histórico de comandos (`tv:history`). A tela ainda não tem histórico; a leitura só nasce atrás desta permissão. */
  readonly history = this.action('tv:history');

  /**
   * A grade de apps do painel tem o que fazer: abrir os apps ou editar os atalhos. Sem nenhum dos dois ela só mostraria
   * uma lista parada, então o painel não a traz.
   */
  readonly appList = computed(() => this.launch() || this.editShortcuts());
  /**
   * O painel dos três pontos tem o que fazer: a grade de apps (abrir ou editar) ou, para quem só controla, a limpeza da
   * TV, que mora nele. Sem nenhum dos três o botão que o abre nem aparece.
   */
  readonly apps = computed(() => this.appList() || this.control());

  private grant(permission: string) {
    return computed(() => userCan(this.session.user(), permission));
  }

  private action(permission: string) {
    const granted = this.grant(permission);
    return computed(() => this.view() && granted());
  }
}
