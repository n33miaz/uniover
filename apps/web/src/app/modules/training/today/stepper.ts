import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  effect,
  input,
  output,
  viewChild,
} from '@angular/core';
import { TrainingGlyph } from '../shell/training-glyph';
import { bumpValue, formatField, parseField } from './set-draft';

let nextStepperId = 0;

/**
 * Campo numérico da série com − e + grandes (56 px: a mão suada na academia não erra o botão). Tocar nos botões soma ou
 * tira um passo; também se digita (vírgula ou ponto). Quem usa guarda o valor: o campo só o mostra e avisa a mudança.
 * Enquanto a pessoa digita, o texto dela não é reescrito; ao sair do campo ele volta ao formato certo.
 */
@Component({
  selector: 'app-live-stepper',
  imports: [TrainingGlyph],
  template: `
    <div class="stepper" role="group" [attr.aria-labelledby]="labelId">
      <span class="text">
        <span class="label" [id]="labelId">{{ label() }}</span>
        @if (hint()) {
          <span class="hint">{{ hint() }}</span>
        }
      </span>
      <button type="button" class="step ui-tap" [attr.aria-label]="lessLabel()" (click)="bump(-1)">
        <app-training-glyph name="minus" />
      </button>
      <input
        #field
        class="value"
        type="text"
        autocomplete="off"
        [attr.inputmode]="decimal() ? 'decimal' : 'numeric'"
        [attr.aria-labelledby]="labelId"
        [attr.aria-invalid]="invalid() ? 'true' : null"
        [placeholder]="empty"
        (input)="onInput($event)"
        (change)="commit()"
        (blur)="commit()"
      />
      <button type="button" class="step ui-tap" [attr.aria-label]="moreLabel()" (click)="bump(1)">
        <app-training-glyph name="plus" />
      </button>
    </div>
  `,
  styleUrl: './stepper.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LiveStepper {
  readonly label = input.required<string>();
  /** Linha de apoio embaixo do nome ("kg · salto 2,5"). */
  readonly hint = input('');
  readonly value = input<number | null>(null);
  readonly step = input.required<number>();
  readonly min = input(0);
  readonly max = input(99999);
  readonly decimal = input(false);
  readonly lessLabel = input.required<string>();
  readonly moreLabel = input.required<string>();
  readonly invalid = input(false);
  readonly valueChange = output<number | null>();

  protected readonly labelId = `live-stepper-${nextStepperId++}`;
  /** O campo vazio mostra um traço: "ainda sem valor". */
  protected readonly empty = '—';

  private readonly field = viewChild.required<ElementRef<HTMLInputElement>>('field');

  constructor() {
    effect(() => {
      const text = formatField(this.value());
      const element = this.field().nativeElement;
      // Quem está digitando não é interrompido: o texto só é reescrito com o campo fora de foco.
      if (element.ownerDocument.activeElement !== element) element.value = text;
    });
  }

  protected bump(direction: 1 | -1): void {
    const element = this.field().nativeElement;
    // O botão assume o foco: o teclado do aparelho desce e o campo passa a mostrar o valor novo.
    element.blur();
    const next = bumpValue(this.value(), direction, this.step(), this.min(), this.max());
    element.value = formatField(next);
    this.valueChange.emit(next);
  }

  protected onInput(event: Event): void {
    const element = event.target as HTMLInputElement;
    const text = element.value;
    const inProgress = this.decimal() ? /^\d{0,5}([.,]\d{0,2})?$/ : /^\d{0,5}$/;
    if (!inProgress.test(text)) {
      // Letra, sinal ou casa a mais: o campo volta ao que valia.
      element.value = formatField(this.value());
      return;
    }
    const parsed = parseField(text, this.decimal());
    // "42," ainda não é um número: espera a pessoa terminar de digitar.
    if (parsed.ok) this.valueChange.emit(parsed.value);
  }

  protected commit(): void {
    this.field().nativeElement.value = formatField(this.value());
  }
}
