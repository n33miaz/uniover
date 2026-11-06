import {
  Component,
  ElementRef,
  afterNextRender,
  computed,
  inject,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { TvApi } from '../data/tv-api';
import { TvStore } from '../data/tv-store';
import { TvPairFailure, cleanPairCode, isPairCode, pairFailureOf } from '../data/tv-pair';
import {
  closeDialog,
  onDialogBackdropClick,
  restoreDialogFocus,
} from '../../../shared/ui/dialog-motion';
import { leaveSheet } from './sheet-motion';

/**
 * Em que ponto a folha está: explicando, pedindo o código à TV, esperando a pessoa digitá-lo (`entry`), pareando,
 * concluída ou com um problema a contar (`refused`: o código não serviu e é preciso pedir outro; os demais pedem para
 * tentar de novo ou só fechar).
 */
export type PairPhase =
  | 'intro'
  | 'asking'
  | 'entry'
  | 'pairing'
  | 'done'
  | 'refused'
  | 'unconfirmed'
  | Exclude<TvPairFailure, 'code'>;

/**
 * Quanto a folha espera o estado da TV sair de "não pareada" depois de o computador aceitar o código (a sessão reabre à
 * parte, em segundos), e de quanto em quanto tempo olha.
 */
export const PAIR_CONFIRM_MS = 20_000;
export const PAIR_CONFIRM_POLL_MS = 250;

function failurePhase(failure: TvPairFailure): PairPhase {
  return failure === 'code' ? 'refused' : failure;
}

/**
 * Folha "Parear a TV": o dono refaz o pareamento da Android TV sem sair do app. Tudo começa no toque dele em "Mostrar
 * Código" (nada aqui abre sozinho nem é repetido sozinho): a TV mostra um código de 6 caracteres, ele o digita e o
 * computador da TV conclui e reabre a sessão: a folha só dá a TV por pareada quando o estado dela deixa de ser "não
 * pareada" (se não deixar, diz que a TV não aceitou). Fechar a folha com o código na tela da TV avisa o computador, que
 * larga o pareamento. O código só existe no campo desta folha: nunca vai para a URL, o armazenamento do navegador
 * nem o registro, e some quando a folha fecha. O `closed` sai depois da saída suave (a página tira a folha do DOM).
 */
@Component({
  selector: 'app-tv-pair-sheet',
  templateUrl: './pair-sheet.html',
  styleUrl: './pair-sheet.css',
})
export class PairSheet {
  private readonly api = inject(TvApi);
  private readonly store = inject(TvStore);
  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');
  private opener: Element | null = null;
  private leaving = false;

  readonly closed = output<void>();

  protected readonly phase = signal<PairPhase>('intro');
  protected readonly code = signal('');
  protected readonly busy = computed(() => this.phase() === 'asking' || this.phase() === 'pairing');
  protected readonly canPair = computed(() => this.phase() === 'entry' && isPairCode(this.code()));
  /** Os problemas em que tentar de novo (do começo) faz sentido. */
  protected readonly canRetry = computed(() =>
    ['unreachable', 'refused', 'unconfirmed', 'wait', 'failed'].includes(this.phase()),
  );

  constructor() {
    afterNextRender(() => {
      const dialog = this.dialog().nativeElement;
      // showModal prende o foco na folha e deixa o resto da tela inerte; o Esc cancela, como "Cancelar".
      this.opener = document.activeElement;
      dialog.showModal();
      onDialogBackdropClick(dialog, () => this.cancel());
    });
  }

  /** "Mostrar Código" e "Tentar de Novo": a TV mostra o código na tela. Só por toque da pessoa. */
  protected async ask(): Promise<void> {
    if (this.busy() || this.leaving) return;
    this.code.set('');
    this.phase.set('asking');
    try {
      await this.api.pair();
    } catch (error) {
      if (!this.leaving) this.phase.set(failurePhase(pairFailureOf(error)));
      return;
    }
    if (this.leaving) return;
    this.phase.set('entry');
    // O campo recém-aparecido já recebe o foco: a pessoa olha a TV e digita.
    queueMicrotask(() => this.dialog().nativeElement.querySelector<HTMLElement>('input')?.focus());
  }

  protected typed(event: Event): void {
    const input = event.target as HTMLInputElement;
    const clean = cleanPairCode(input.value);
    // O campo mostra o que ficou (sem espaços, letras fora do código nem o que passa de 6).
    if (input.value !== clean) input.value = clean;
    this.code.set(clean);
  }

  /** "Parear": entrega o código digitado ao computador da TV, que conclui o pareamento. */
  protected async pair(event?: Event): Promise<void> {
    event?.preventDefault();
    if (!this.canPair() || this.leaving) return;
    this.phase.set('pairing');
    try {
      await this.api.pair(this.code());
    } catch (error) {
      if (!this.leaving) this.phase.set(failurePhase(pairFailureOf(error)));
      return;
    } finally {
      // O código serviu ou não: de qualquer jeito não fica na folha.
      this.code.set('');
    }
    // A TV aceitou o código; a sessão reabre à parte. Só vale "pareada" quando o estado sai de "não pareada".
    const confirmed = await this.confirmed();
    if (!this.leaving) this.phase.set(confirmed ? 'done' : 'unconfirmed');
  }

  private async confirmed(): Promise<boolean> {
    const deadline = Date.now() + PAIR_CONFIRM_MS;
    while (!this.leaving) {
      if (this.store.status() !== 'not-paired') return true;
      if (Date.now() >= deadline) return false;
      await new Promise<void>((resolve) => setTimeout(resolve, PAIR_CONFIRM_POLL_MS));
    }
    return false;
  }

  /** "Cancelar", "Fechar", "Pronto" e Esc. */
  protected cancel(event?: Event): void {
    event?.preventDefault(); // quem tira a folha do DOM é a página; evita o fechamento duplo do navegador
    this.leave();
  }

  private leave(): void {
    if (this.leaving) return;
    this.leaving = true;
    this.code.set('');
    if (this.phase() === 'asking' || this.phase() === 'entry') {
      // A TV mostra o código até o computador desistir: avisa que a folha fechou, sem esperar e sem barulho.
      void this.api.cancelPair().catch(() => undefined);
    }
    const dialog = this.dialog().nativeElement;
    leaveSheet(dialog, () => {
      closeDialog(dialog);
      restoreDialogFocus(this.opener);
      this.closed.emit();
    });
  }
}
