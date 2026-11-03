import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  afterNextRender,
  input,
  output,
  viewChild,
} from '@angular/core';
import {
  closeDialog,
  onDialogBackdropClick,
  restoreDialogFocus,
} from '../../../shared/ui/dialog-motion';

/**
 * Folha de confirmação das ações que derrubam a conexão com o PC (suspender e desligar): sobe de baixo, sem botão de
 * fechar (a saída é "Cancelar", o Esc ou tocar fora). O foco começa em "Cancelar", o lado seguro. Quem a abre decide o que
 * dizer e o que acontece ao confirmar; ela só devolve a escolha.
 */
@Component({
  selector: 'app-pc-confirm-sheet',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <dialog
      #dialog
      class="sheet"
      aria-labelledby="pc-confirm-title"
      aria-describedby="pc-confirm-text"
      (cancel)="dismiss($event)"
    >
      <h2 id="pc-confirm-title">{{ heading() }}</h2>
      <p id="pc-confirm-text" class="text">{{ text() }}</p>
      @if (error(); as message) {
        <p class="error" role="alert">{{ message }}</p>
      }
      <div class="footer">
        <button
          type="button"
          class="ui-btn"
          [disabled]="busy()"
          (click)="dismiss()"
          i18n="@@pc.confirm.cancel"
        >
          Cancelar
        </button>
        <button type="button" class="ui-btn danger" [disabled]="busy()" (click)="confirmed.emit()">
          {{ confirmLabel() }}
        </button>
      </div>
    </dialog>
  `,
  styleUrl: './confirm-sheet.css',
})
export class PcConfirmSheet {
  readonly heading = input.required<string>();
  readonly text = input.required<string>();
  readonly confirmLabel = input.required<string>();
  /** Enquanto o pedido está a caminho os dois botões ficam travados. */
  readonly busy = input(false);
  /** O motivo de o pedido ter falhado; a folha continua aberta para a pessoa tentar de novo ou cancelar. */
  readonly error = input<string | null>(null);

  readonly confirmed = output<void>();
  readonly closed = output<void>();

  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');
  private opener: Element | null = null;

  constructor() {
    afterNextRender(() => {
      const dialog = this.dialog().nativeElement;
      this.opener = document.activeElement;
      dialog.showModal();
      // O fundo escurecido é o próprio <dialog>: só fecha se o toque começou e terminou fora da folha.
      onDialogBackdropClick(dialog, () => this.dismiss());
      dialog.querySelector<HTMLElement>('button')?.focus();
    });
  }

  /** Fecha sem confirmar (o navegador também chega aqui pelo Esc: quem tira a folha do DOM é a página). */
  protected dismiss(event?: Event): void {
    event?.preventDefault();
    if (this.busy()) return;
    this.close();
  }

  /** A página chama depois de o pedido dar certo. */
  close(): void {
    const dialog = this.dialog().nativeElement;
    closeDialog(dialog);
    restoreDialogFocus(this.opener);
    this.closed.emit();
  }
}
