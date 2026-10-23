import { Component, computed, inject, input, output } from '@angular/core';
import { RouterLink } from '@angular/router';
import { SessionState } from '../../../core/session/session-state';
import { TvAccess } from '../data/tv-access';
import { TvPrefs } from '../data/tv-prefs';
import { TvStore } from '../data/tv-store';
import { TvIcon } from './tv-icon';

/** O que o menu pede à tela: abrir o painel Apps ou a folha Personalizar (o menu fecha antes). */
export type TvMenuChoice = 'apps' | 'customize';

/** Onde o administrador escolhe qual computador controla a TV (a tela de ajustes do sistema). */
export const TV_BINDING_ROUTE = '/ajustes/sistema';

/**
 * Conteúdo do menu de três pontos do cabeçalho (vai dentro de um `TvPanel`). Reúne num lugar só o que antes ficava
 * espalhado: os apps da TV, a personalização do controle e, só para o administrador, escolher qual computador controla a
 * TV. As escolhas de aparência e de uso (Personalizar, atalhos escondidos) são da pessoa e ficam neste aparelho, em
 * chave própria por conta (`TvPrefs`): mudar aqui não muda nada para os outros. O que vale para todos (trocar o
 * computador da TV) fica em grupo à parte e traz o aviso "Afeta todos". Cada linha só existe para quem pode usá-la.
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
  private readonly store = inject(TvStore);
  private readonly isGuest = inject(SessionState).isGuest;

  /** O nome da linha dos apps: "Apps da TV", ou "Opções da TV" para quem só controla (é o título do painel que ela abre). */
  readonly appsLabel = input.required<string>();
  readonly choose = output<TvMenuChoice>();

  /** Só o administrador (a conta dona) escolhe o computador da TV; a rota também é só dele. */
  protected readonly canBind = computed(() => !this.isGuest());
  protected readonly bindingRoute = TV_BINDING_ROUTE;
  protected readonly bindingLabel = computed(() =>
    this.store.status() === 'unconfigured'
      ? $localize`:@@tv.menu.configure:Configurar TV`
      : $localize`:@@tv.menu.switch:Trocar a TV`,
  );

  /** Sugestões removidas que podem voltar: só para quem edita os atalhos, que é quem as vê. */
  protected readonly canRestoreSuggestions = computed(
    () => this.access.editShortcuts() && this.prefs.dismissedSuggestions().length > 0,
  );

  protected restoreSuggestions(): void {
    this.prefs.set({ dismissedSuggestions: [] });
  }
}
