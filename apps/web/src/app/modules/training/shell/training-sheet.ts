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
  leaveDialog,
  onDialogBackdropClick,
  restoreDialogFocus,
} from '../../../shared/ui/dialog-motion';

let nextSheetId = 0;

/**
 * Folha que sobe de baixo, sem botão de fechar no canto: a saída é o "Fechar" do rodapé (ou o Esc, ou um toque
 * fora). É um `<dialog>` modal: o foco fica preso nela e o resto da tela fica inerte. A folha desce antes de avisar o
 * pai por `closed`, que é quem a tira do DOM. O miolo vai por projeção; o rodapé leva o "Fechar" e, se quiser, ações
 * a mais (`<button sheetAction>`).
 */
@Component({
  selector: 'app-training-sheet',
  templateUrl: './training-sheet.html',
  styleUrl: './training-sheet.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TrainingSheet {
  readonly heading = input.required<string>();
  /** Texto do botão de saída; "Fechar" vale para folhas só de leitura, "Cancelar" para as que decidem algo. */
  readonly dismissLabel = input<string>($localize`:@@training.sheet.close:Fechar`);
  readonly closed = output<void>();

  protected readonly titleId = `training-sheet-title-${nextSheetId++}`;
  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');
  private opener: Element | null = null;
  private leaving = false;

  constructor() {
    afterNextRender(() => {
      const dialog = this.dialog().nativeElement;
      // showModal prende o foco na folha, deixa o resto da tela inerte e trata o Esc.
      this.opener = document.activeElement;
      dialog.showModal();
      // O fundo escurecido é o próprio <dialog>; só fecha se o toque começou e terminou fora da folha.
      onDialogBackdropClick(dialog, () => this.close());
    });
  }

  /** Toca a descida e só então avisa o pai; um segundo pedido durante a descida não repete o aviso. */
  close(event?: Event): void {
    event?.preventDefault(); // o pai tira a folha do DOM; evita o fechamento duplo do navegador
    if (this.leaving) return;
    this.leaving = true;
    const dialog = this.dialog().nativeElement;
    leaveDialog(dialog, () => {
      closeDialog(dialog);
      restoreDialogFocus(this.opener);
      this.closed.emit();
    });
  }
}
