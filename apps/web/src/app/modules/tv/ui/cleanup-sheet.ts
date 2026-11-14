import {
  Component,
  ElementRef,
  afterNextRender,
  computed,
  inject,
  output,
  viewChild,
} from '@angular/core';
import { cleanupReasonText } from '../../../shared/tv-cleanup-text';
import { TvStore } from '../data/tv-store';
import { clockText } from '../data/tv-types';
import {
  closeDialog,
  onDialogBackdropClick,
  restoreDialogFocus,
} from '../../../shared/ui/dialog-motion';
import { leaveSheet } from './sheet-motion';

/**
 * Folha "Limpar a TV?": sobe de baixo, sem botão de fechar (a saída é "Cancelar" ou Esc), no mesmo padrão da folha de
 * desligar. Limpar sempre alivia a memória; só fecha apps em segundo plano (nunca o que está passando agora) se o
 * interruptor desta TV estiver ligado, e o texto da folha diz qual dos dois vale. Nada disso
 * derruba a conexão do controle. A limpeza leva alguns segundos, então ao confirmar a folha sai na hora e o pedido
 * segue pelo `TvStore` (o botão do painel mostra "Limpando…" e o resultado volta como aviso): uma folha modal aberta
 * por até 25 s deixaria o resto do controle parado. A sheet mostra também a última limpeza, que antes ficava no painel Apps. O `closed` só sai depois da saída suave, para a página não
 * desmontar a folha no meio dela.
 */
@Component({
  selector: 'app-tv-cleanup-sheet',
  templateUrl: './cleanup-sheet.html',
  styleUrl: './cleanup-sheet.css',
})
export class CleanupSheet {
  protected readonly store = inject(TvStore);
  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');
  private opener: Element | null = null;

  /** O interruptor desta TV: ligado, a limpeza fecha apps em segundo plano; desligado (ou sem saber), só libera memória. */
  protected readonly closesBackground = computed(
    () => this.store.selectedTv()?.allowBackgroundAppClosing === true,
  );

  /** A última limpeza em uma frase (feita ou pulada), para quem vai decidir se limpa de novo; vazia sem nenhuma. */
  protected readonly lastText = computed(() => {
    const result = this.store.lastCleanup();
    if (!result) return '';
    if (result.result === 'skipped') {
      const reason = cleanupReasonText(result.reason);
      return $localize`:@@tv.cleanup.last-skipped:Limpeza pulada: ${reason}:reason:.`;
    }
    const freed = result.freedMb ?? 0;
    return freed >= 1
      ? $localize`:@@tv.cleanup.last-result:Limpeza feita às ${clockText(result.at)}:time:, liberou ${freed}:mb: MB.`
      : $localize`:@@tv.cleanup.last-done:Limpeza feita às ${clockText(result.at)}:time:.`;
  });

  readonly closed = output<void>();

  /** A saída já começou: nem um segundo toque nem um segundo pedido valem mais. */
  private leaving = false;

  constructor() {
    afterNextRender(() => {
      // showModal prende o foco na folha (começa em "Cancelar"), deixa o resto inerte e trata o Esc.
      const dialog = this.dialog().nativeElement;
      this.opener = document.activeElement;
      dialog.showModal();
      // O fundo escurecido é o próprio <dialog>; só fecha se o toque começou e terminou fora da folha.
      onDialogBackdropClick(dialog, () => this.cancel());
    });
  }

  protected cancel(event?: Event): void {
    event?.preventDefault(); // quem tira a folha do DOM é a página; evita o fechamento duplo do navegador
    this.leave();
  }

  protected confirm(): void {
    if (this.leaving || !this.store.canSend() || this.store.cleaning()) return;
    // Sem esperar: o andamento e o resultado são do `TvStore`, que mostra "Limpando…" e o aviso no fim.
    void this.store.cleanup();
    this.leave();
  }

  private leave(): void {
    if (this.leaving) return;
    this.leaving = true;
    const dialog = this.dialog().nativeElement;
    leaveSheet(dialog, () => {
      closeDialog(dialog);
      restoreDialogFocus(this.opener);
      this.closed.emit();
    });
  }
}
