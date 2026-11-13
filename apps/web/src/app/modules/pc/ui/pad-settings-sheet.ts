import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  afterNextRender,
  computed,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import {
  closeDialog,
  onDialogBackdropClick,
  restoreDialogFocus,
} from '../../../shared/ui/dialog-motion';
import { PcAvailability } from '../../../core/modules/pc-availability';
import { PcPrefs, type PcPrefsValue } from '../data/pc-prefs';
import { PC_ZOOM_CAPABILITY } from '../data/pc-types';
import { canVibrate } from '../input/haptics';
import {
  DEFAULT_LEVEL,
  SENSITIVITY_LEVELS,
  isSensitivityLevel,
  type SensitivityLevel,
} from '../input/pc-acceleration';

const MIN_LEVEL = SENSITIVITY_LEVELS[0];
const MAX_LEVEL = SENSITIVITY_LEVELS[SENSITIVITY_LEVELS.length - 1];

/** O que o leitor de tela diz do controle deslizante: o nível, e "padrão" no do meio. */
export function levelText(level: SensitivityLevel): string {
  return level === DEFAULT_LEVEL
    ? $localize`:@@pc.settings.level-default:${level}:level: de ${MAX_LEVEL}:max:, padrão`
    : $localize`:@@pc.settings.level:${level}:level: de ${MAX_LEVEL}:max:`;
}

/** Os interruptores da folha, na ordem em que aparecem. */
type SwitchName =
  | 'showTyped'
  | 'invertScroll'
  | 'doubleTapDrag'
  | 'middleClick'
  | 'pinchZoom'
  | 'clickButtons'
  | 'haptics'
  | 'keepAwake';

/**
 * Ajustes do mouse numa folha que sobe de baixo: a sensibilidade do ponteiro e da rolagem (controles deslizantes de 1 a 7, o
 * meio é o padrão), a aceleração e os interruptores. Cada escolha vale na hora e fica guardada neste aparelho (`PcPrefs`); a
 * folha só fecha por "Fechar", pelo Esc ou tocando fora. Aberta pelo botão do touchpad (`quick`), mostra só a sensibilidade,
 * com "Mais ajustes" para o resto, na mesma folha.
 */
@Component({
  selector: 'app-pc-pad-settings-sheet',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <dialog #dialog class="sheet" aria-labelledby="pad-settings-title" (cancel)="dismiss($event)">
      <h2 id="pad-settings-title" i18n="@@pc.settings.title">Ajustes</h2>

      <div class="level">
        <label class="level-head" for="pad-sensitivity">
          <span id="pad-sensitivity-label" i18n="@@pc.settings.sensitivity">Sensibilidade</span>
          <output class="level-value" for="pad-sensitivity">{{ prefs.sensitivity() }}</output>
        </label>
        <input
          id="pad-sensitivity"
          type="range"
          aria-labelledby="pad-sensitivity-label"
          class="slider"
          [min]="min"
          [max]="max"
          step="1"
          [value]="prefs.sensitivity()"
          [attr.aria-valuetext]="text(prefs.sensitivity())"
          (input)="onLevel('sensitivity', $event)"
        />
      </div>

      <label class="row">
        <span i18n="@@pc.settings.acceleration">Aceleração</span>
        <input
          type="checkbox"
          role="switch"
          class="ui-switch"
          [checked]="prefs.acceleration()"
          (change)="onSwitch('acceleration', $event)"
        />
      </label>

      <div class="level">
        <label class="level-head" for="scroll-sensitivity">
          <span id="scroll-sensitivity-label" i18n="@@pc.settings.scroll">Rolagem</span>
          <output class="level-value" for="scroll-sensitivity">{{
            prefs.scrollSensitivity()
          }}</output>
        </label>
        <input
          id="scroll-sensitivity"
          type="range"
          aria-labelledby="scroll-sensitivity-label"
          class="slider"
          [min]="min"
          [max]="max"
          step="1"
          [value]="prefs.scrollSensitivity()"
          [attr.aria-valuetext]="text(prefs.scrollSensitivity())"
          (input)="onLevel('scrollSensitivity', $event)"
        />
      </div>

      @if (showAll()) {
        @for (item of visibleSwitches(); track item.name) {
          <label class="row">
            <span>{{ item.label }}</span>
            <input
              type="checkbox"
              role="switch"
              class="ui-switch"
              [checked]="prefs[item.name]()"
              (change)="onSwitch(item.name, $event)"
            />
          </label>
        }
      } @else {
        <button
          type="button"
          class="ui-btn more"
          (click)="expanded.set(true)"
          i18n="@@pc.settings.more"
        >
          Mais ajustes
        </button>
      }

      <div class="footer">
        <button type="button" class="ui-btn" (click)="dismiss()" i18n="@@pc.settings.close">
          Fechar
        </button>
      </div>
    </dialog>
  `,
  styleUrl: './confirm-sheet.css',
  styles: `
    .level {
      display: grid;
      gap: var(--space-1);
    }
    .level-head {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      font-weight: 650;
    }
    .level-value {
      min-width: 2ch;
      color: var(--a-accent-ink);
      font-variant-numeric: tabular-nums;
      text-align: end;
    }
    /* O controle nativo, na cor do app, com a altura de um alvo de toque inteiro. */
    .slider {
      width: 100%;
      min-height: var(--tap);
      margin: 0;
      accent-color: var(--a-accent);
      cursor: pointer;
    }
    .slider:focus-visible {
      outline: 3px solid var(--a-accent);
      outline-offset: 2px;
    }
    .more {
      justify-self: start;
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
  private readonly availability = inject(PcAvailability);
  readonly closed = output<void>();

  /** Aberta pelo botão do touchpad: só a sensibilidade à vista, o resto atrás de "Mais ajustes". */
  readonly quick = input(false);
  /** No modo rápido, "Mais ajustes" foi tocado. */
  protected readonly expanded = signal(false);
  protected readonly showAll = computed(() => !this.quick() || this.expanded());

  protected readonly min = MIN_LEVEL;
  protected readonly max = MAX_LEVEL;
  protected readonly text = levelText;

  protected readonly switches: readonly { name: SwitchName; label: string }[] = (
    [
      {
        name: 'showTyped',
        label: $localize`:@@pc.settings.show-typed:Mostrar o que digito`,
      },
      { name: 'invertScroll', label: $localize`:@@pc.settings.invert:Inverter rolagem` },
      {
        name: 'doubleTapDrag',
        label: $localize`:@@pc.settings.double-tap-drag:Toque duplo arrasta`,
      },
      {
        name: 'middleClick',
        label: $localize`:@@pc.settings.middle-click:Clique do meio com três dedos`,
      },
      { name: 'pinchZoom', label: $localize`:@@pc.settings.pinch-zoom:Pinça para zoom` },
      { name: 'clickButtons', label: $localize`:@@pc.settings.click-buttons:Botões de clique` },
      // O iPhone não vibra: o ajuste só aparece onde existe.
      ...(canVibrate()
        ? [{ name: 'haptics' as const, label: $localize`:@@pc.settings.haptics:Vibração` }]
        : []),
      { name: 'keepAwake', label: $localize`:@@pc.settings.keep-awake:Manter a tela acesa` },
    ] as const
  ).map((item) => ({ ...item }));

  /** A pinça só aparece com um PC que entende o zoom: para os outros ela não faria nada. */
  protected readonly visibleSwitches = computed(() =>
    this.switches.filter(
      (item) =>
        item.name !== 'pinchZoom' || this.availability.capabilities().includes(PC_ZOOM_CAPABILITY),
    ),
  );

  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');
  private opener: Element | null = null;

  constructor() {
    afterNextRender(() => {
      const dialog = this.dialog().nativeElement;
      this.opener = document.activeElement;
      dialog.showModal();
      onDialogBackdropClick(dialog, () => this.dismiss());
      // O foco nasce na sensibilidade, não num interruptor ligado.
      dialog.querySelector<HTMLElement>('#pad-sensitivity')?.focus();
    });
  }

  /** O controle deslizante mudou: vale na hora (o próximo toque já usa o nível novo). */
  protected onLevel(name: 'sensitivity' | 'scrollSensitivity', event: Event): void {
    const level = Number((event.target as HTMLInputElement).value);
    if (isSensitivityLevel(level)) this.prefs.set({ [name]: level });
  }

  protected onSwitch(name: SwitchName | 'acceleration', event: Event): void {
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
