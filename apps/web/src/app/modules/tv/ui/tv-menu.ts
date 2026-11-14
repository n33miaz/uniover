import { Component, computed, inject, output } from '@angular/core';
import { RouterLink } from '@angular/router';
import { SessionState } from '../../../core/session/session-state';
import { TvAccess } from '../data/tv-access';
import { TV_SETUP_ROUTE, TvHelpGuides } from '../data/tv-help-guides';
import { TvPrefs } from '../data/tv-prefs';
import { TvRoundKeys } from '../data/tv-round-keys';
import { TvStore } from '../data/tv-store';
import { TvSelection } from '../data/tv-selection';
import { tvHasLivre } from '../livre/data/livre-types';
import { TvIcon } from './tv-icon';

/**
 * O que o menu pede à tela (o menu fecha antes): abrir o painel Apps, o Mais botões, a folha Personalizar, a de limpar a TV
 * ou a de ajuda, ou uma ação na própria TV, que só roda por este toque (a tela de rede, as configurações ou a lista de
 * entradas).
 */
export type TvMenuChoice =
  'apps' | 'keys' | 'customize' | 'cleanup' | 'help' | 'network' | 'settings' | 'inputs';

/** Onde o administrador gerencia as TVs: quais existem, qual computador controla cada uma e quem usa (ajustes do sistema). */
export const TV_BINDING_ROUTE = '/ajustes/sistema';

/**
 * Conteúdo do menu de três pontos do cabeçalho (vai dentro de um `TvPanel`), em quatro blocos: o que é da pessoa (os apps da
 * TV, mais botões e Personalizar), as ações na própria TV em botões lado a lado, o que vale para todos (só do administrador:
 * TV Livre e escolher qual computador controla a TV) e a ajuda. As escolhas de aparência e de uso são da pessoa e ficam neste
 * aparelho, em chave própria por conta (`TvPrefs`): mudar aqui não muda nada para os outros. O título "Para todos" diz que o
 * grupo afeta quem usa a TV, uma vez só. Cada linha só existe para quem pode usá-la.
 */
@Component({
  selector: 'app-tv-menu',
  imports: [RouterLink, TvIcon],
  templateUrl: './tv-menu.html',
  styleUrl: './tv-menu.css',
})
export class TvMenu {
  protected readonly access = inject(TvAccess);
  protected readonly prefs = inject(TvPrefs);
  protected readonly roundKeys = inject(TvRoundKeys);
  protected readonly store = inject(TvStore);
  protected readonly guides = inject(TvHelpGuides);
  private readonly selection = inject(TvSelection);
  private readonly isGuest = inject(SessionState).isGuest;

  readonly choose = output<TvMenuChoice>();

  /** Só o administrador (a conta dona) escolhe o computador da TV; a rota também é só dele. */
  protected readonly canBind = computed(() => !this.isGuest());
  protected readonly canOpenLivre = computed(
    () => !this.isGuest() && tvHasLivre(this.selection.selected()),
  );
  protected readonly bindingRoute = computed(() =>
    this.store.status() === 'unconfigured' ? TV_SETUP_ROUTE : TV_BINDING_ROUTE,
  );
  protected readonly bindingLabel = computed(() =>
    this.store.status() === 'unconfigured'
      ? $localize`:@@tv.menu.configure:Configurar TV`
      : $localize`:@@tv.menu.manage:Gerenciar TVs`,
  );

  /** O nome do botão de limpar diz também o que está acontecendo. */
  protected readonly cleanLabel = computed(() =>
    this.store.cleaning()
      ? $localize`:@@tv.menu.cleaning:Limpando…`
      : $localize`:@@tv.menu.cleanup:Limpar`,
  );

  /**
   * Sugestões removidas que podem voltar por esta linha: só para quem edita os atalhos (quem as vê) e não tem Personalizar,
   * que é onde elas voltam para quem controla.
   */
  protected readonly canRestoreHere = computed(
    () =>
      this.access.editShortcuts() &&
      !this.access.control() &&
      this.prefs.dismissedSuggestions().length > 0,
  );

  protected restoreSuggestions(): void {
    this.prefs.set({ dismissedSuggestions: [] });
  }

  /**
   * Limpar abre a folha de confirmação (o menu fecha antes). Apagado e focável, não `disabled`: sem agente, ou com uma
   * limpeza em curso, o toque não faz nada e o menu continua aberto.
   */
  protected clean(): void {
    if (!this.store.canSend() || this.store.cleaning() || !this.access.cleanup()) return;
    this.choose.emit('cleanup');
  }
}
