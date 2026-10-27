import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import type { LocalBodyEntry } from '../../data/body/body-entry';
import { type BodyEntryDraft, BodyRepository } from '../../data/body/body-repository';
import type { BodyEntryIssue } from '../../domain/body/body-limits';
import { round1 } from '../../domain/body/rounding';
import { TrainingSheet } from '../../shell/training-sheet';
import { dayMonth, parseDecimal, toFieldText } from '../body-text';

let nextWeightSheetId = 0;

/**
 * Folha para registrar um peso (ou corrigir/apagar um que já existe). O peso digitado é arredondado para uma casa antes de
 * gravar: o número que vai para o aparelho e para o servidor é o mesmo que a tela mostra depois. Duas pesagens no mesmo dia
 * são aceitas (a tendência usa a última). Grava só pelo repositório: banco local e fila de envio, uma vez.
 */
@Component({
  selector: 'app-weight-sheet',
  imports: [TrainingSheet],
  template: `
    <app-training-sheet [heading]="heading()" [dismissLabel]="cancelLabel" (closed)="closed.emit()">
      <div class="ui-field">
        <label [for]="weightId" i18n="@@training.body.weight.field">Peso (kg)</label>
        <input
          [id]="weightId"
          class="ui-input"
          type="text"
          autocomplete="off"
          [attr.inputmode]="'decimal'"
          [attr.enterkeyhint]="'done'"
          [attr.aria-invalid]="error() ? 'true' : null"
          [attr.aria-describedby]="error() ? errorId : null"
          [value]="weightText()"
          (input)="weightDraft.set($any($event.target).value)"
          (keydown.enter)="save()"
        />
      </div>
      <div class="ui-field">
        <label [for]="dateId" i18n="@@training.body.weight.date">Dia</label>
        <input
          [id]="dateId"
          class="ui-input"
          type="date"
          [attr.min]="'1900-01-01'"
          [max]="today()"
          [value]="dateText()"
          (input)="dateDraft.set($any($event.target).value)"
        />
      </div>
      @if (error(); as message) {
        <p class="error" role="alert" [id]="errorId">{{ message }}</p>
      }
      @if (entry() !== null) {
        @if (confirming()) {
          <div class="ui-notice warn" role="group" [attr.aria-label]="confirmLabel">
            <span class="confirm">
              <span i18n="@@training.body.weight.delete-ask">Apagar esta pesagem?</span>
              <span class="confirm-actions">
                <button type="button" class="danger ui-btn" (click)="remove()">
                  <span i18n="@@training.body.weight.delete-yes">Apagar</span>
                </button>
                <button type="button" class="secondary ui-btn" (click)="confirming.set(false)">
                  <span i18n="@@training.body.weight.delete-no">Manter</span>
                </button>
              </span>
            </span>
          </div>
        } @else {
          <button type="button" class="remove" (click)="confirming.set(true)">
            <span i18n="@@training.body.weight.delete">Apagar Pesagem</span>
          </button>
        }
      }
      <button sheetAction type="button" class="primary ui-btn" (click)="save()">
        <span i18n="@@training.body.weight.save">Salvar</span>
      </button>
    </app-training-sheet>
  `,
  styleUrl: './weight-sheet.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class WeightSheet {
  private readonly body = inject(BodyRepository);
  private readonly sheet = viewChild.required(TrainingSheet);

  /** A pesagem que está sendo corrigida; `null` ao registrar uma nova. */
  readonly entry = input<LocalBodyEntry | null>(null);
  /** O dia de hoje do aparelho (o último dia aceito). */
  readonly today = input.required<string>();
  readonly closed = output<void>();

  protected readonly cancelLabel = $localize`:@@training.body.weight.cancel:Cancelar`;
  protected readonly confirmLabel = $localize`:@@training.body.weight.delete-confirm:Confirmar a exclusão`;
  protected readonly weightId = `weight-input-${nextWeightSheetId}`;
  protected readonly dateId = `weight-date-${nextWeightSheetId}`;
  protected readonly errorId = `weight-error-${nextWeightSheetId++}`;
  protected readonly weightDraft = signal<string | null>(null);
  protected readonly dateDraft = signal<string | null>(null);
  protected readonly error = signal('');
  protected readonly confirming = signal(false);

  protected readonly heading = computed(() => {
    const entry = this.entry();
    if (entry === null) return $localize`:@@training.body.weight.sheet-new:Registrar Peso`;
    const day = dayMonth(entry.measuredOn);
    return $localize`:@@training.body.weight.sheet-edit:Pesagem de ${day}:day:`;
  });

  /** O texto do campo: o que a pessoa digitou, ou o peso atual da pesagem em edição. */
  protected readonly weightText = computed(() => {
    const typed = this.weightDraft();
    if (typed !== null) return typed;
    const weight = this.entry()?.weightKg ?? null;
    return weight === null ? '' : toFieldText(weight);
  });

  protected readonly dateText = computed(
    () => this.dateDraft() ?? this.entry()?.measuredOn ?? this.today(),
  );

  protected async save(): Promise<void> {
    const value = parseDecimal(this.weightText());
    if (value === null) {
      this.error.set($localize`:@@training.body.weight.not-a-number:Digite o peso, como 82,4.`);
      return;
    }

    const existing = this.entry();
    const measuredOn = this.dateText() || this.today();
    // O que o dono viu é o que vai: uma casa decimal.
    const draft: BodyEntryDraft = {
      ...(existing === null
        ? {}
        : {
            bodyFatPct: existing.bodyFatPct,
            fatMethod: existing.fatMethod,
            waistCm: existing.waistCm,
            neckCm: existing.neckCm,
            hipCm: existing.hipCm,
            armCm: existing.armCm,
            thighCm: existing.thighCm,
            note: existing.note,
          }),
      measuredOn,
      weightKg: round1(value),
    };
    const result = await this.body.saveEntry(draft, existing?.id);
    switch (result.status) {
      case 'saved':
      case 'not-found':
        this.sheet().close();
        return;
      case 'invalid':
        this.error.set(this.issueText(result.issues));
        return;
      case 'storage-full':
        this.error.set(this.storageText());
        return;
    }
  }

  protected async remove(): Promise<void> {
    const existing = this.entry();
    if (existing === null) return;
    const result = await this.body.softDeleteEntry(existing.id);
    if (result.status === 'storage-full') {
      this.confirming.set(false);
      this.error.set(this.storageText());
      return;
    }
    this.sheet().close();
  }

  private issueText(issues: readonly BodyEntryIssue[]): string {
    if (issues.some((issue) => issue.path === 'measuredOn')) {
      return $localize`:@@training.body.weight.date-invalid:Escolha um dia até hoje.`;
    }
    return $localize`:@@training.body.weight.range:Use de 20 a 400 kg.`;
  }

  private storageText(): string {
    return $localize`:@@training.body.weight.storage:Sem espaço no aparelho para guardar o peso. Libere espaço e tente de novo.`;
  }
}
