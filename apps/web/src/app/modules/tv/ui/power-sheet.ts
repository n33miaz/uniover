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

/**
 * Folha "Desligar a TV?": sobe de baixo, sem botão de fechar (a saída é "Cancelar" ou Esc). Desligar é a única
 * ação perigosa do controle, porque sem o emissor infravermelho a TV só volta com o controle original. Por decisão
 * do dono a confirmação é só esta folha (sem passkey). Se o pedido falhar, o motivo aparece aqui dentro e a folha
 * continua aberta; se der certo, ela fecha e o aviso fica na tela.
 */
@Component({
  selector: 'app-power-sheet',
  templateUrl: './power-sheet.html',
  styleUrl: './power-sheet.css',
})
export class PowerSheet {
  protected readonly store = inject(TvStore);
  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');

  readonly closed = output<void>();

  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);

  constructor() {
    afterNextRender(() => {
      // showModal prende o foco na folha (começa em "Cancelar"), deixa o resto inerte e trata o Esc.
      this.dialog().nativeElement.showModal();
    });
  }

  protected cancel(event?: Event): void {
    event?.preventDefault(); // quem tira a folha do DOM é a página; evita o fechamento duplo do navegador
    if (!this.busy()) this.closed.emit();
  }

  protected async confirm(): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    this.error.set(null);
    try {
      const failure = await this.store.powerOff();
      if (failure) {
        this.error.set(failure.message);
        return;
      }
      this.closed.emit();
    } finally {
      this.busy.set(false);
    }
  }
}
