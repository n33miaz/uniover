import {
  Component,
  DestroyRef,
  ElementRef,
  afterNextRender,
  computed,
  inject,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { FullTextSender } from '../data/live-text-sender';
import { LiveTextSync } from '../data/live-text';
import { TV_CONFIG } from '../data/tv-config';
import { TV_TEXT_MAX, TvStore } from '../data/tv-store';

/** Só mostra o contador quando o limite está perto (80%), para não encher o painel de números. */
const COUNT_FROM = Math.floor(TV_TEXT_MAX * 0.8);

/**
 * Painel Teclado: um campo de uma linha, no topo do painel flutuante, que espelha em tempo real o campo aberto na
 * TV (a TV pode aceitar só em caixas de busca). O painel fica aberto sobre o controle, então dá para digitar e
 * apertar uma tecla sem trocar de tela. Não há "Enviar": a forma de mandar o texto fica toda atrás do
 * {@link FullTextSender} e da {@link LiveTextSync}, que esta tela só liga ao campo. O campo não limpa sozinho,
 * porque ele é o espelho do da TV. "Limpar" esvazia só o campo do celular; "Fechar" fecha (o que estiver pendente
 * é enviado antes, ao destruir o painel).
 */
@Component({
  selector: 'app-tv-keyboard',
  templateUrl: './keyboard-panel.html',
  styleUrl: './keyboard-panel.css',
})
export class KeyboardPanel {
  protected readonly store = inject(TvStore);

  private readonly field = viewChild.required<ElementRef<HTMLInputElement>>('field');

  readonly done = output<void>();

  protected readonly max = TV_TEXT_MAX;
  protected readonly text = signal('');

  private readonly sync = new LiveTextSync({
    debounceMs: inject(TV_CONFIG).textDebounceMs,
    sender: new FullTextSender(this.store),
  });
  protected readonly status = this.sync.status;
  protected readonly failure = this.sync.failure;

  protected readonly length = computed(() => [...this.text()].length);
  protected readonly tooLong = computed(() => this.length() > this.max);
  protected readonly showCount = computed(() => this.length() >= COUNT_FROM);

  /** Quando a falha vem sem texto (erro inesperado), a tela usa esta frase. */
  protected readonly fallbackFailure = $localize`:@@tv.keyboard.failed:Não foi possível enviar o texto agora.`;

  constructor() {
    // Fechar o painel com texto pendente (dentro da pausa de digitação) não pode perdê-lo.
    inject(DestroyRef).onDestroy(() => this.sync.flush());
    // O campo já nasce com o foco: quem abriu o teclado quer digitar (o aparelho decide se mostra o teclado dele).
    afterNextRender(() => this.field().nativeElement.focus());
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

  protected close(): void {
    this.done.emit();
  }
}
