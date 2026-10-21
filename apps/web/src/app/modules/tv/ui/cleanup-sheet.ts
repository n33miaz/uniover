import { Component, ElementRef, afterNextRender, inject, output, viewChild } from '@angular/core';
import { TvStore } from '../data/tv-store';
import { leaveSheet } from './sheet-motion';

/**
 * Folha "Limpar a TV?": sobe de baixo, sem botão de fechar (a saída é "Cancelar" ou Esc), no mesmo padrão da folha de
 * desligar. Limpar fecha todos os apps abertos na TV, inclusive o que está passando agora, e libera memória sem
 * derrubar a conexão do controle. A limpeza leva alguns segundos, então ao confirmar a folha sai na hora e o pedido
 * segue pelo `TvStore` (o botão do painel mostra "Limpando…" e o resultado volta como aviso): uma folha modal aberta
 * por até 25 s deixaria o resto do controle parado. O `closed` só sai depois da saída suave, para a página não
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

  readonly closed = output<void>();

  /** A saída já começou: nem um segundo toque nem um segundo pedido valem mais. */
  private leaving = false;

  constructor() {
    afterNextRender(() => {
      // showModal prende o foco na folha (começa em "Cancelar"), deixa o resto inerte e trata o Esc.
      this.dialog().nativeElement.showModal();
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
    leaveSheet(this.dialog().nativeElement, () => this.closed.emit());
  }
}
