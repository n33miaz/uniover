import { Component, ElementRef, afterNextRender, inject, output, signal, viewChild } from '@angular/core';
import { DOCUMENT } from '@angular/common';
import { RouterLink } from '@angular/router';
import { leaveDialog, onDialogBackdropClick } from '../../shared/ui/dialog-motion';
import { CONNECTOR_URL, isWindowsPc } from './windows-pc';

/**
 * Folha "Conectar este PC": o mesmo caminho único do instalador (um link no PC, um QR no celular, o resto sozinho).
 * No próprio PC com Windows, o botão baixa o conector; em outro aparelho (o celular, quase sempre), a folha mostra o
 * endereço para abrir no PC, com o botão de copiar. Sobe de baixo, sem botão de fechar redondo (a saída é "Fechar",
 * Esc ou o toque no fundo) e desce antes de avisar a página, que a tira do DOM. Baixar não fecha a folha: o dono ainda
 * precisa dos passos na tela enquanto abre o arquivo.
 */
@Component({
  selector: 'app-connect-sheet',
  imports: [RouterLink],
  templateUrl: './connect-sheet.html',
  styleUrl: './connect-sheet.css',
})
export class ConnectSheet {
  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');
  private readonly document = inject(DOCUMENT);

  readonly closed = output<void>();

  protected readonly connectorUrl = CONNECTOR_URL;
  protected readonly windowsPc = isWindowsPc(navigator);
  /** A página pública que o PC abre: baixa o conector e mostra os avisos do navegador. */
  protected readonly pageUrl = `${this.document.location.origin}/conectar`;
  protected readonly copied = signal(false);
  private readonly leaving = signal(false);

  constructor() {
    afterNextRender(() => {
      // showModal prende o foco na folha, deixa o resto da tela inerte e trata o Esc.
      const dialog = this.dialog().nativeElement;
      dialog.showModal();
      onDialogBackdropClick(dialog, () => this.close());
    });
  }

  protected async copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(this.pageUrl);
      this.copied.set(true);
    } catch {
      // Sem permissão da área de transferência: o endereço continua na tela para ser digitado.
      this.copied.set(false);
    }
  }

  protected close(event?: Event): void {
    event?.preventDefault(); // quem tira a folha do DOM é a página; evita o fechamento duplo do navegador
    if (this.leaving()) return;
    this.leaving.set(true);
    leaveDialog(this.dialog().nativeElement, () => this.closed.emit());
  }
}
