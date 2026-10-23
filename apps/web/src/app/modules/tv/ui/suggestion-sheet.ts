import { Component, computed, inject, input, output, signal } from '@angular/core';
import { TvAccess } from '../data/tv-access';
import { TvPrefs } from '../data/tv-prefs';
import { TvStore } from '../data/tv-store';
import { TvSuggestedApp, matchSuggestion } from '../data/tv-suggestions';
import { AppIcon } from './app-icon';
import { AppIconSubject } from './app-icon-source';

/**
 * Conteúdo do painel de uma sugestão de atalho (vai dentro de um `TvPanel`): o app sugerido, o aviso de que é só uma
 * sugestão e as duas saídas, confirmar ou remover. Confirmar fixa no controle o atalho que a TV já listou para esse app;
 * se a lista dela não o traz, não há o que fixar (a API não cria atalhos), e o painel diz isso e, para quem pode pedir a
 * lista à TV (`tv:launch`), leva ao painel Apps, onde ela se atualiza. Remover guarda a escolha neste aparelho, por conta, e a sugestão não volta (o menu a devolve).
 */
@Component({
  selector: 'app-tv-suggestion',
  imports: [AppIcon],
  templateUrl: './suggestion-sheet.html',
  styleUrl: './suggestion-sheet.css',
})
export class SuggestionSheet {
  protected readonly store = inject(TvStore);
  private readonly prefs = inject(TvPrefs);
  protected readonly access = inject(TvAccess);

  readonly app = input.required<TvSuggestedApp>();
  /** Terminou o que veio fazer: o painel pode fechar. */
  readonly done = output<void>();
  /** Pede o painel Apps (o menu da tela o abre depois que este fechar). */
  readonly openApps = output<void>();

  protected readonly busy = signal(false);

  /** O atalho real da TV para este app, se a lista dela já o trouxe. */
  protected readonly match = computed(() => matchSuggestion(this.app(), this.store.shortcuts()));

  /** Com o atalho real vem o ícone real; sem ele, a inicial do nome sobre a cor do pacote. */
  protected readonly subject = computed<AppIconSubject>(() => {
    const app = this.app();
    return (
      this.match() ?? {
        package: app.packages[0] ?? app.key,
        position: 1,
        customLabel: null,
        tvLabel: app.label,
      }
    );
  });

  protected async pin(): Promise<void> {
    const match = this.match();
    if (!match || this.busy()) return;
    this.busy.set(true);
    try {
      if (await this.store.setShortcutEnabled(match.id, true)) this.done.emit();
    } finally {
      this.busy.set(false);
    }
  }

  protected remove(): void {
    const dismissed = this.prefs.dismissedSuggestions();
    this.prefs.set({ dismissedSuggestions: [...dismissed, this.app().key] });
    this.done.emit();
  }
}
