import {
  Component,
  ElementRef,
  afterNextRender,
  inject,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { TvStore } from '../data/tv-store';
import {
  closeDialog,
  onDialogBackdropClick,
  restoreDialogFocus,
} from '../../../shared/ui/dialog-motion';
import { leaveSheet } from './sheet-motion';
import { TvIcon } from './tv-icon';

/**
 * Folha "Desligar a TV?": sobe de baixo, sem botão de fechar (a saída é "Cancelar" ou Esc). Desligar é a única
 * ação perigosa do controle, porque sem o emissor infravermelho a TV só volta com o controle original. Por decisão
 * do dono a confirmação é só esta folha (sem passkey). Se o pedido falhar, o motivo aparece aqui dentro e a folha
 * continua aberta; se der certo, ela fecha e o aviso fica na tela. A entrada e a saída são suaves (CSS); o `closed`
 * só sai depois da saída, para a página não desmontar a folha no meio dela. Dentro dela há a linha "Agendar
 * desligamento", marcada "Em breve": ainda não existe no agente, então não é um botão.
 */
@Component({
  selector: 'app-power-sheet',
  imports: [TvIcon],
  templateUrl: './power-sheet.html',
  styleUrl: './power-sheet.css',
})
export class PowerSheet {
  protected readonly store = inject(TvStore);
  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');
  private opener: Element | null = null;

  readonly closed = output<void>();

  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
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
    if (!this.busy()) this.leave();
  }

  protected async confirm(): Promise<void> {
    if (this.busy() || this.leaving) return;
    this.busy.set(true);
    this.error.set(null);
    try {
      const failure = await this.store.powerOff();
      if (failure) {
        this.error.set(failure.message);
        return;
      }
      this.leave();
    } finally {
      // Na saída os botões seguem travados: a folha está sumindo e não pode pedir de novo.
      if (!this.leaving) this.busy.set(false);
    }
  }

  private leave(): void {
    this.leaving = true;
    const dialog = this.dialog().nativeElement;
    leaveSheet(dialog, () => {
      closeDialog(dialog);
      restoreDialogFocus(this.opener);
      this.closed.emit();
    });
  }
}
