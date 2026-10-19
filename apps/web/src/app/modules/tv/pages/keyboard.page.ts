import { Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { LiveTextSync } from '../data/live-text';
import { TV_CONFIG } from '../data/tv-config';
import { TV_TEXT_MAX, TvStore, isValidTvText } from '../data/tv-store';

/**
 * Aba Teclado: um campo de uma linha que espelha, em tempo real, o campo aberto na TV (a TV pode aceitar só em
 * caixas de busca). A cada pausa de digitação o app manda o texto completo; não há "Enviar" nem "OK", e o campo não
 * limpa sozinho, porque ele é o espelho do da TV. O controle remoto não consegue esvaziar o campo da TV, então texto
 * vazio nunca é enviado e a tela avisa. "Limpar" esvazia só o campo do celular; "Voltar ao controle" sai da aba
 * (o que estiver pendente é enviado antes).
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

  private readonly sync = new LiveTextSync({
    debounceMs: inject(TV_CONFIG).textDebounceMs,
    send: (text) => this.store.sendText(text),
    isValid: isValidTvText,
  });
  protected readonly status = this.sync.status;
  protected readonly failure = this.sync.failure;

  protected readonly length = computed(() => [...this.text()].length);
  protected readonly tooLong = computed(() => this.length() > this.max);

  /** Quando a falha vem sem texto (erro inesperado), a tela usa esta frase. */
  protected readonly fallbackFailure = $localize`:@@tv.keyboard.failed:Não foi possível enviar o texto agora.`;

  constructor() {
    // Sair da aba com texto pendente (dentro da pausa de digitação) não pode perdê-lo.
    inject(DestroyRef).onDestroy(() => this.sync.flush());
  }

  protected onInput(event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    this.text.set(value);
    this.sync.change(value);
  }

  /** Enter manda já o que estiver pendente, sem esperar a pausa. */
  protected submit(event: Event): void {
    event.preventDefault();
    this.sync.flush();
  }

  protected clear(): void {
    this.text.set('');
    this.sync.reset();
  }

  protected back(): void {
    void this.router.navigateByUrl('/tv');
  }
}
