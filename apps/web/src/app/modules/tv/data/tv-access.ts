import { Injectable, computed, inject } from '@angular/core';
import { userCan } from '../../../core/session/access';
import { SessionState } from '../../../core/session/session-state';
import { TvSelection } from './tv-selection';
import { tvSupports } from './tv-types';

/**
 * O que a pessoa pode fazer na TV, um signal para cada permissão da API (a mesma que ela confere em cada rota). A tela
 * consulta só aqui, em vez de cada componente reler a lista: o que a pessoa não pode, ela não vê, e o controle nunca faz
 * uma chamada que o servidor recusaria. Reage na hora quando a sessão traz outra lista de permissões.
 *
 * Toda ação da TV exige ver a TV (a API recusa a lista que traga uma sem a outra, e a conferência das rotas também),
 * então `view` é parte de todas elas.
 *
 * Além da permissão, o que a TV em uso **sabe fazer** (`TvSelection`): a Samsung não digita nem limpa, e uma Android sem
 * ADB não lista apps. Essas ações somem junto com as que a conta não pode, pelos mesmos signals. Sem informação da TV
 * (lista que não chegou, agente desligado) vale que ela faz tudo: esconder por falta de dado tiraria botões à toa.
 */
@Injectable({ providedIn: 'root' })
export class TvAccess {
  private readonly session = inject(SessionState);
  private readonly selection = inject(TvSelection);

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

  /**
   * A grade de apps do painel tem o que fazer: abrir os apps ou editar os atalhos. Sem nenhum dos dois ela só mostraria
   * uma lista parada, então o painel não a traz.
   */
  readonly appList = computed(
    () => (this.launch() || this.editShortcuts()) && tvSupports(this.selection.selected(), 'apps'),
  );
  /** Limpar a TV: é do controle e só existe onde a TV tem o canal para isso (ADB). */
  readonly cleanup = computed(
    () => this.control() && tvSupports(this.selection.selected(), 'cleanup'),
  );
  /** Digitar na TV (aba Teclado): é do controle e só onde a TV recebe texto. */
  readonly text = computed(() => this.control() && tvSupports(this.selection.selected(), 'text'));
  /**
   * O painel dos três pontos tem o que fazer: a grade de apps (abrir ou editar) ou, para quem só controla, a limpeza da
   * TV, que mora nele. Sem nenhum dos três o botão que o abre nem aparece.
   */
  readonly apps = computed(() => this.appList() || this.cleanup());

  private grant(permission: string) {
    return computed(() => userCan(this.session.user(), permission));
  }

  private action(permission: string) {
    const granted = this.grant(permission);
    return computed(() => this.view() && granted());
  }
}
