import { ChangeDetectionStrategy, Component, inject, input, output, signal } from '@angular/core';
import { PcArmed } from '../data/pc-armed';
import { PC_MODIFIERS, type PcKey, type PcModifier } from '../data/pc-types';
import { tick } from '../input/haptics';
import { PcRepeat } from './pc-repeat';

interface PanelKey {
  readonly key: PcKey;
  readonly label: string;
  readonly aria: string;
  /** Posição na grade de cinco colunas (a cruz das setas). */
  readonly cell: string;
}

/** Os nomes das teclas modificadoras não se traduzem: são as que estão no teclado do PC. */
const MODIFIER_LABEL: Readonly<Record<PcModifier, string>> = {
  CTRL: 'Ctrl',
  SHIFT: 'Shift',
  ALT: 'Alt',
  WIN: 'Win',
};

const FUNCTION_KEYS = [
  'F1',
  'F2',
  'F3',
  'F4',
  'F5',
  'F6',
  'F7',
  'F8',
  'F9',
  'F10',
  'F11',
  'F12',
] as const satisfies readonly PcKey[];

/**
 * O painel de teclas (✥), que abre sobre a parte de baixo da superfície: as teclas armadas (Ctrl, Shift, Alt e Win valem
 * para a próxima tecla), as de navegação e uma fileira com F1 a F12. Setas, páginas, Home, End e Del repetem ao segurar. As
 * teclas armadas são as de `PcArmed`, as mesmas da barra de ações e da folha de atalhos.
 */
@Component({
  selector: 'app-pc-key-panel',
  imports: [PcRepeat],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="panel" role="group" aria-label="Mais teclas" i18n-aria-label="@@pc.bar.more-keys">
      <div
        class="row mods"
        role="group"
        aria-label="Teclas armadas"
        i18n-aria-label="@@pc.keyboard.modifiers"
      >
        @for (mod of modifiers; track mod) {
          <button
            type="button"
            class="key"
            [class.on]="armed.has(mod)"
            [attr.aria-pressed]="armed.has(mod)"
            [disabled]="disabled()"
            (click)="toggle(mod)"
          >
            {{ label(mod) }}
          </button>
        }
        <button
          type="button"
          class="key"
          [class.on]="functionRow()"
          [attr.aria-expanded]="functionRow()"
          (click)="functionRow.set(!functionRow())"
        >
          {{ fnText }}
        </button>
      </div>

      @if (functionRow()) {
        <div
          class="row fkeys"
          role="group"
          aria-label="F1 a F12"
          i18n-aria-label="@@pc.keyboard.fkeys"
        >
          @for (item of functionKeys; track item) {
            <button type="button" class="key" [disabled]="disabled()" (click)="press(item)">
              {{ item }}
            </button>
          }
        </div>
      }

      <div
        class="row nav"
        role="group"
        aria-label="Navegação"
        i18n-aria-label="@@pc.panel.navigation"
      >
        @for (item of navKeys; track item.key) {
          <button
            type="button"
            class="key"
            [attr.data-key]="item.key"
            [style.grid-area]="item.cell"
            [disabled]="disabled()"
            [attr.aria-label]="item.aria"
            (appPcRepeat)="press(item.key)"
            [repeatSkip]="busy()"
          >
            {{ item.label }}
          </button>
        }
      </div>
    </div>
  `,
  styleUrls: ['./key-button.css', './key-panel.css'],
})
export class PcKeyPanel {
  protected readonly armed = inject(PcArmed);
  readonly disabled = input(false);
  /** Devolve `true` quando já há teclas demais sem resposta: a repetição pula a rodada. */
  readonly busy = input<() => boolean>(() => false);
  readonly key = output<PcKey>();

  protected readonly modifiers = PC_MODIFIERS;
  protected readonly functionRow = signal(false);
  protected readonly fnText = 'Fn';
  protected readonly functionKeys = FUNCTION_KEYS;

  protected readonly navKeys: readonly PanelKey[] = [
    {
      key: 'HOME',
      label: 'Home',
      cell: '1 / 1',
      aria: $localize`:@@pc.key.home:Home (início da linha)`,
    },
    {
      key: 'PAGE_UP',
      label: 'PgUp',
      cell: '1 / 2',
      aria: $localize`:@@pc.key.page-up:PgUp (página para cima)`,
    },
    {
      key: 'DELETE',
      label: 'Del',
      cell: '1 / 3',
      aria: $localize`:@@pc.key.delete:Del (Delete)`,
    },
    { key: 'UP', label: '↑', cell: '1 / 4', aria: $localize`:@@pc.key.up:Seta para cima` },
    { key: 'SPACE', label: '␣', cell: '1 / 5', aria: $localize`:@@pc.key.space:Espaço` },
    {
      key: 'END',
      label: 'End',
      cell: '2 / 1',
      aria: $localize`:@@pc.key.end:End (fim da linha)`,
    },
    {
      key: 'PAGE_DOWN',
      label: 'PgDn',
      cell: '2 / 2',
      aria: $localize`:@@pc.key.page-down:PgDn (página para baixo)`,
    },
    {
      key: 'LEFT',
      label: '←',
      cell: '2 / 3',
      aria: $localize`:@@pc.key.left:Seta para a esquerda`,
    },
    { key: 'DOWN', label: '↓', cell: '2 / 4', aria: $localize`:@@pc.key.down:Seta para baixo` },
    {
      key: 'RIGHT',
      label: '→',
      cell: '2 / 5',
      aria: $localize`:@@pc.key.right:Seta para a direita`,
    },
  ];

  protected label(modifier: PcModifier): string {
    return MODIFIER_LABEL[modifier];
  }

  protected toggle(modifier: PcModifier): void {
    tick();
    this.armed.toggle(modifier);
  }

  protected press(key: PcKey): void {
    this.key.emit(key);
  }
}
