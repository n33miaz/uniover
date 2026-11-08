import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  afterNextRender,
  inject,
  output,
  viewChild,
} from '@angular/core';
import {
  closeDialog,
  onDialogBackdropClick,
  restoreDialogFocus,
} from '../../../shared/ui/dialog-motion';
import { PcPrefs, type PcPrefsValue } from '../data/pc-prefs';
import { POINTER_SENSITIVITIES, type PointerSensitivity } from '../input/pc-acceleration';

const LABELS: Readonly<Record<PointerSensitivity, () => string>> = {
  low: () => $localize`:@@pc.settings.low:Baixa`,
  normal: () => $localize`:@@pc.settings.normal:Normal`,
  high: () => $localize`:@@pc.settings.high:Alta`,
  boosted: () => $localize`:@@pc.settings.boosted:Acelerada`,
};

/**
 * Ajustes do mouse numa folha que sobe de baixo: a sensibilidade do ponteiro, a rolagem invertida, os botões de clique e
 * a tela acesa. Cada escolha vale na hora e fica guardada neste aparelho (`PcPrefs`); a folha só fecha por "Fechar", pelo
 * Esc ou tocando fora.
 */
@Component({
  selector: 'app-pc-pad-settings-sheet',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <dialog #dialog class="sheet" aria-labelledby="pad-settings-title" (cancel)="dismiss($event)">
      <h2 id="pad-settings-title" i18n="@@pc.settings.title">Ajustes</h2>

      <fieldset class="segment">
        <legend class="legend" i18n="@@pc.settings.sensitivity">Sensibilidade</legend>
        @for (choice of choices; track choice.value) {
          <label class="option">
            <input
              type="radio"
              name="pad-sensitivity"
              [value]="choice.value"
              [checked]="prefs.sensitivity() === choice.value"
              (change)="prefs.set({ sensitivity: choice.value })"
            />
            <span class="option-label">{{ choice.label }}</span>
          </label>
        }
      </fieldset>

      <label class="row">
        <span i18n="@@pc.settings.invert">Inverter rolagem</span>
        <input
          type="checkbox"
          role="switch"
          class="ui-switch"
          [checked]="prefs.invertScroll()"
          (change)="onSwitch('invertScroll', $event)"
        />
      </label>

      <label class="row">
        <span i18n="@@pc.settings.click-buttons">Botões de clique</span>
        <input
          type="checkbox"
          role="switch"
          class="ui-switch"
          [checked]="prefs.clickButtons()"
          (change)="onSwitch('clickButtons', $event)"
        />
      </label>

      <label class="row">
        <span i18n="@@pc.settings.keep-awake">Manter a tela acesa</span>
        <input
          type="checkbox"
          role="switch"
          class="ui-switch"
          [checked]="prefs.keepAwake()"
          (change)="onSwitch('keepAwake', $event)"
        />
      </label>

      <div class="footer">
        <button type="button" class="ui-btn" (click)="dismiss()" i18n="@@pc.settings.close">
          Fechar
        </button>
      </div>
    </dialog>
  `,
  styleUrl: './confirm-sheet.css',
  styles: `
    .segment {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 4px;
      min-width: 0;
      margin: 0;
      padding: 4px;
      border: 1px solid var(--a-line);
      border-radius: var(--radius);
      background: var(--a-surface);
    }
    .legend {
      grid-column: 1 / -1;
      float: none;
      padding: 0 var(--space-1);
      color: var(--a-ink2);
      font-size: var(--fs-small);
      font-weight: 650;
    }
    .option {
      position: relative;
      display: grid;
      place-items: center;
      min-height: var(--tap);
      padding: 0 var(--space-1);
      border-radius: var(--radius-sm);
      color: var(--a-ink2);
      font-size: var(--fs-small);
      font-weight: 650;
      cursor: pointer;
    }
    .option-label {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    /* O botão de opção de verdade cobre a opção inteira, invisível: o toque cai nele. */
    .option input {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      margin: 0;
      opacity: 0;
      cursor: pointer;
    }
    .option:has(input:checked) {
      background: var(--a-accent-soft);
      color: var(--a-accent-ink);
      box-shadow: inset 0 0 0 1.5px var(--a-accent);
    }
    .option:has(input:focus-visible) {
      outline: 3px solid var(--a-accent);
      outline-offset: 2px;
    }
    .row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--space-3);
      min-height: var(--tap);
      font-weight: 650;
    }
  `,
})
export class PcPadSettingsSheet {
  protected readonly prefs = inject(PcPrefs);
  readonly closed = output<void>();

  protected readonly choices: readonly { value: PointerSensitivity; label: string }[] =
    POINTER_SENSITIVITIES.map((value) => ({ value, label: LABELS[value]() }));

  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');
  private opener: Element | null = null;

  constructor() {
    afterNextRender(() => {
      const dialog = this.dialog().nativeElement;
      this.opener = document.activeElement;
      dialog.showModal();
      onDialogBackdropClick(dialog, () => this.dismiss());
      dialog.querySelector<HTMLElement>('input:checked')?.focus();
    });
  }

  protected onSwitch(name: 'invertScroll' | 'clickButtons' | 'keepAwake', event: Event): void {
    const patch: Partial<PcPrefsValue> = { [name]: (event.target as HTMLInputElement).checked };
    this.prefs.set(patch);
  }

  /** Fecha a folha (o navegador também chega aqui pelo Esc: quem tira a folha do DOM é a página). */
  protected dismiss(event?: Event): void {
    event?.preventDefault();
    closeDialog(this.dialog().nativeElement);
    restoreDialogFocus(this.opener);
    this.closed.emit();
  }
}
