import { Component, inject, input, output, signal } from '@angular/core';
import { TvPrefs } from '../data/tv-prefs';
import { TvStore } from '../data/tv-store';
import { TvShortcut } from '../data/tv-types';
import { AppIcon } from './app-icon';

/**
 * Conteúdo do painel de uma sugestão de atalho (vai dentro de um `TvPanel`). A sugestão é sempre um app que a TV
 * informou como instalado, com o ícone que veio dela: confirmar o fixa no controle; "Escolher outro app" leva à lista
 * dos apps instalados (o seletor), para fixar outro no lugar; remover guarda a escolha neste aparelho, por conta (pelo
 * pacote), e a sugestão não volta (o menu a devolve).
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

  readonly app = input.required<TvShortcut>();
  /** Terminou o que veio fazer: o painel pode fechar. */
  readonly done = output<void>();
  /** Pede o seletor de apps (a tela o abre depois que este painel fechar). */
  readonly choose = output<void>();

  protected readonly busy = signal(false);

  protected async pin(): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    try {
      if (await this.store.setShortcutEnabled(this.app().id, true)) this.done.emit();
    } finally {
      this.busy.set(false);
    }
  }

  protected remove(): void {
    const dismissed = this.prefs.dismissedSuggestions();
    this.prefs.set({ dismissedSuggestions: [...dismissed, this.app().package] });
    this.done.emit();
  }
}
