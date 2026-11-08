import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  afterNextRender,
  inject,
  output,
  signal,
  viewChild,
} from '@angular/core';
import {
  closeDialog,
  onDialogBackdropClick,
  restoreDialogFocus,
} from '../../../shared/ui/dialog-motion';
import { PcStore } from '../data/pc-store';
import { tick } from '../input/haptics';
import { PcArmedPills } from './armed-pills';
import { PcShortcutGrid } from './shortcut-grid';

/**
 * A folha de atalhos (⚡): sobe de baixo e ocupa dois terços da tela. Tocar num atalho o envia e a folha **fica aberta**
 * (o segundo toque encadeia: Alt+Tab, Alt+Tab); fecha pelo X, pelo Esc ou tocando fora. O lápis liga o modo de edição, em
 * que tocar fixa ou solta o atalho. "Arrastar" trava o botão esquerdo até soltar (o mesmo do botão que os ajustes mostram).
 */
@Component({
  selector: 'app-pc-shortcut-sheet',
  imports: [PcArmedPills, PcShortcutGrid],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <dialog #dialog class="sheet" aria-labelledby="pc-shortcuts-title" (cancel)="dismiss($event)">
      <header class="head">
        <h2 #title id="pc-shortcuts-title" tabindex="-1" i18n="@@pc.sc.title">Atalhos</h2>
        <app-pc-armed-pills [fallback]="title" />
        <button
          type="button"
          class="icon"
          [class.on]="editing()"
          [attr.aria-pressed]="editing()"
          aria-label="Editar fixados"
          i18n-aria-label="@@pc.sc.edit"
          (click)="editing.set(!editing())"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path [attr.d]="'M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4'" />
          </svg>
        </button>
        <button
          type="button"
          class="icon"
          aria-label="Fechar"
          i18n-aria-label="@@pc.sc.close"
          (click)="dismiss()"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path [attr.d]="'M6 6l12 12M18 6 6 18'" />
          </svg>
        </button>
      </header>

      <button
        type="button"
        class="drag"
        [class.on]="store.dragging()"
        [attr.aria-pressed]="store.dragging()"
        [disabled]="!store.canSend() && !store.dragging()"
        (click)="drag()"
        i18n="@@pc.pad.drag"
      >
        Arrastar
      </button>

      <app-pc-shortcut-grid [editing]="editing()" />
    </dialog>
  `,
  styleUrls: ['./confirm-sheet.css', './shortcut-sheet.css'],
})
export class PcShortcutSheet {
  protected readonly store = inject(PcStore);
  readonly closed = output<void>();
  protected readonly editing = signal(false);

  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');
  private opener: Element | null = null;

  constructor() {
    afterNextRender(() => {
      const dialog = this.dialog().nativeElement;
      this.opener = document.activeElement;
      dialog.showModal();
      onDialogBackdropClick(dialog, () => this.dismiss());
      // O foco começa no título, não no lápis: o primeiro botão focado pareceria ligado.
      dialog.querySelector<HTMLElement>('h2')?.focus();
    });
  }

  protected drag(): void {
    tick();
    void this.store.toggleDrag();
  }

  /** Fecha a folha (o navegador também chega aqui pelo Esc: quem tira a folha do DOM é a página). */
  protected dismiss(event?: Event): void {
    event?.preventDefault();
    closeDialog(this.dialog().nativeElement);
    restoreDialogFocus(this.opener);
    this.closed.emit();
  }
}
