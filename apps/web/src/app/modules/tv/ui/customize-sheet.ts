import { Component, ElementRef, afterNextRender, inject, output, viewChild } from '@angular/core';
import { InstallHintRow } from '../../../core/pwa/install-hint-row';
import {
  closeDialog,
  onDialogBackdropClick,
  restoreDialogFocus,
} from '../../../shared/ui/dialog-motion';
import {
  TV_NAME_MAX,
  TvButtonSize,
  TvPadSpeed,
  TvPillLayout,
  TvPrefs,
  TvPrefsValue,
  TvStartPage,
} from '../data/tv-prefs';
import { leaveSheet } from './sheet-motion';

interface Choice<T extends string> {
  readonly value: T;
  readonly label: string;
}

/**
 * Folha "Personalizar": o apelido da TV, o tamanho dos botões, a disposição das pílulas de volume e canal, que grupos
 * de teclas aparecem, a vibração, a página com que o palco abre e a sensibilidade do touchpad. Sobe de baixo como a de
 * desligar. Cada mudança vale na hora (o controle fica atrás da folha, com a escolha à vista) e é guardada neste
 * aparelho pelo `TvPrefs`; por isso não há "Aplicar", só "Concluir". "Restaurar padrão" volta tudo ao que o controle
 * era.
 */
@Component({
  selector: 'app-tv-customize-sheet',
  imports: [InstallHintRow],
  templateUrl: './customize-sheet.html',
  styleUrl: './customize-sheet.css',
})
export class CustomizeSheet {
  protected readonly prefs = inject(TvPrefs);
  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');
  private readonly nameField = viewChild.required<ElementRef<HTMLInputElement>>('nameField');
  private readonly doneButton = viewChild.required<ElementRef<HTMLButtonElement>>('done');
  private opener: Element | null = null;

  readonly closed = output<void>();

  protected readonly nameMax = TV_NAME_MAX;
  /**
   * O campo nasce com o apelido de agora e depois só o teclado o muda: ligá-lo ao valor guardado (que é aparado)
   * comeria o espaço digitado no fim, e "TV da sala" nunca passaria de "TVda".
   */
  protected readonly initialName = this.prefs.name();

  protected readonly sizes: readonly Choice<TvButtonSize>[] = [
    { value: 'compact', label: $localize`:@@tv.custom.size.compact:Compacto` },
    { value: 'comfortable', label: $localize`:@@tv.custom.size.comfortable:Confortável` },
    { value: 'large', label: $localize`:@@tv.custom.size.large:Grande` },
  ];
  protected readonly layouts: readonly Choice<TvPillLayout>[] = [
    { value: 'sides', label: $localize`:@@tv.custom.layout.sides:Nas laterais` },
    { value: 'row', label: $localize`:@@tv.custom.layout.row:Em fileira, acima` },
  ];
  protected readonly pages: readonly Choice<TvStartPage>[] = [
    { value: 'directions', label: $localize`:@@tv.custom.page.directions:Direções` },
    { value: 'numbers', label: $localize`:@@tv.custom.page.numbers:Números` },
    { value: 'touchpad', label: $localize`:@@tv.custom.page.touchpad:Touchpad` },
    { value: 'last', label: $localize`:@@tv.custom.page.last:Última usada` },
  ];
  protected readonly speeds: readonly Choice<TvPadSpeed>[] = [
    { value: 'slow', label: $localize`:@@tv.custom.speed.slow:Lenta` },
    { value: 'normal', label: $localize`:@@tv.custom.speed.normal:Normal` },
    { value: 'fast', label: $localize`:@@tv.custom.speed.fast:Rápida` },
  ];

  constructor() {
    afterNextRender(() => {
      // showModal prende o foco na folha (em "Concluir", para o teclado do aparelho não abrir sozinho), deixa o resto
      // inerte e trata o Esc.
      const dialog = this.dialog().nativeElement;
      this.opener = document.activeElement;
      dialog.showModal();
      // O fundo escurecido é o próprio <dialog>; só fecha se o toque começou e terminou fora da folha.
      onDialogBackdropClick(dialog, () => this.close());
    });
  }

  protected setName(text: string): void {
    this.prefs.set({ name: text });
  }

  protected change(patch: Partial<TvPrefsValue>): void {
    this.prefs.set(patch);
  }

  protected restore(): void {
    this.prefs.reset();
    this.nameField().nativeElement.value = '';
    // O botão acabou de ficar desligado (já está no padrão): o foco não pode se perder junto com ele.
    this.doneButton().nativeElement.focus();
  }

  protected close(event?: Event): void {
    event?.preventDefault(); // quem tira a folha do DOM é a página; evita o fechamento duplo do navegador
    const dialog = this.dialog().nativeElement;
    leaveSheet(dialog, () => {
      closeDialog(dialog);
      restoreDialogFocus(this.opener);
      this.closed.emit();
    });
  }
}
