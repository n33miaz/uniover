import { Component, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { TV_TEXT_MAX, TvStore, isValidTvText } from '../data/tv-store';

/**
 * Aba Teclado: um campo de uma linha e "Enviar". O texto vai para o campo que estiver aberto na TV (a TV pode
 * aceitar só em caixas de busca) e não fica guardado depois do envio. "Cancelar" limpa e volta ao controle.
 */
@Component({
  selector: 'app-tv-keyboard',
  templateUrl: './keyboard.page.html',
  styleUrl: './keyboard.page.css',
})
export class KeyboardPage {
  protected readonly store = inject(TvStore);
  private readonly router = inject(Router);

  protected readonly max = TV_TEXT_MAX;
  protected readonly text = signal('');
  protected readonly busy = signal(false);

  protected readonly length = computed(() => [...this.text()].length);
  protected readonly valid = computed(() => isValidTvText(this.text()));
  protected readonly canSend = computed(() => this.store.canSend() && this.valid() && !this.busy());

  protected onInput(event: Event): void {
    this.text.set((event.target as HTMLInputElement).value);
  }

  protected async send(event: Event): Promise<void> {
    event.preventDefault();
    if (!this.canSend()) return;
    this.busy.set(true);
    try {
      // O texto só some quando a TV confirmou; se falhar, fica para tentar de novo.
      if (await this.store.sendText(this.text())) this.text.set('');
    } finally {
      this.busy.set(false);
    }
  }

  protected cancel(): void {
    this.text.set('');
    void this.router.navigateByUrl('/tv');
  }
}
