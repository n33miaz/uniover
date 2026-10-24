import { Component, ElementRef, afterNextRender, output, signal, viewChild } from '@angular/core';
import { RouterLink } from '@angular/router';
import { leaveDialog, onDialogBackdropClick } from '../../shared/ui/dialog-motion';
import { CONNECTOR_URL } from './windows-pc';

/**
 * Folha "Conectar este PC": três passos curtos e o botão que baixa o conector. Sobe de baixo, sem botão de fechar
 * redondo (a saída é "Fechar", Esc ou o toque no fundo) e desce antes de avisar a página, que a tira do DOM.
 * Baixar não fecha a folha: o dono ainda precisa dos passos na tela enquanto abre o arquivo.
 */
@Component({
  selector: 'app-connect-sheet',
  imports: [RouterLink],
  templateUrl: './connect-sheet.html',
  styleUrl: './connect-sheet.css',
})
export class ConnectSheet {
  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');

  readonly closed = output<void>();

  protected readonly connectorUrl = CONNECTOR_URL;
  private readonly leaving = signal(false);

  constructor() {
    afterNextRender(() => {
      // showModal prende o foco na folha, deixa o resto da tela inerte e trata o Esc.
      const dialog = this.dialog().nativeElement;
      dialog.showModal();
      onDialogBackdropClick(dialog, () => this.close());
    });
  }

  protected close(event?: Event): void {
    event?.preventDefault(); // quem tira a folha do DOM é a página; evita o fechamento duplo do navegador
    if (this.leaving()) return;
    this.leaving.set(true);
    leaveDialog(this.dialog().nativeElement, () => this.closed.emit());
  }
}
