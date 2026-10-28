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
import { GoalRepository } from '../../data/goals/goal-repository';
import { GOAL_LIMITS, type GoalIssue, type GoalKind } from '../../domain/progress/goal-model';
import { TrainingSheet } from '../../shell/training-sheet';

let nextGoalSheetId = 0;

/**
 * Folha para definir, trocar ou remover uma meta (a de 1RM de um exercício ou a de treinos por semana). A meta é do dono:
 * o app não sugere valor, só confere os limites e grava pelo repositório (banco local e fila de envio, uma vez).
 */
@Component({
  selector: 'app-goal-sheet',
  imports: [TrainingSheet],
  template: `
    <app-training-sheet [heading]="heading()" [dismissLabel]="cancelLabel" (closed)="closed.emit()">
      <div class="ui-field">
        <label [for]="inputId">{{ fieldLabel() }}</label>
        <input
          [id]="inputId"
          class="ui-input"
          type="text"
          autocomplete="off"
          [attr.inputmode]="kind() === 'weekly_sessions' ? 'numeric' : 'decimal'"
          [attr.aria-invalid]="error() ? 'true' : null"
          [attr.aria-describedby]="error() ? errorId : null"
          [value]="text()"
          (input)="draft.set($any($event.target).value)"
          (keydown.enter)="save()"
        />
      </div>
      <p class="hint">{{ hint() }}</p>
      @if (error(); as message) {
        <p class="error" role="alert" [id]="errorId">{{ message }}</p>
      }
      @if (current() !== null) {
        <button type="button" class="remove" (click)="remove()">
          <span i18n="@@training.progress.goal.remove">Remover Meta</span>
        </button>
      }
      <button sheetAction type="button" class="primary ui-btn" (click)="save()">
        <span i18n="@@training.progress.goal.save">Salvar</span>
      </button>
    </app-training-sheet>
  `,
  styleUrl: './goal-sheet.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class GoalSheet {
  private readonly goals = inject(GoalRepository);
  private readonly sheet = viewChild.required(TrainingSheet);

  readonly kind = input.required<GoalKind>();
  /** O exercício da meta de 1RM; `null` na meta de treinos por semana. */
  readonly exerciseId = input<string | null>(null);
  readonly heading = input.required<string>();
  readonly fieldLabel = input.required<string>();
  /** O valor atual da meta, ou `null` se não há. */
  readonly current = input<number | null>(null);
  readonly closed = output<void>();

  protected readonly cancelLabel = $localize`:@@training.progress.goal.cancel:Cancelar`;
  protected readonly inputId = `goal-input-${nextGoalSheetId}`;
  protected readonly errorId = `goal-error-${nextGoalSheetId++}`;
  protected readonly draft = signal<string | null>(null);
  protected readonly error = signal('');

  protected readonly hint = computed(() => {
    const limits = GOAL_LIMITS[this.kind()];
    if (this.kind() === 'weekly_sessions') {
      return $localize`:@@training.progress.goal.hint-weekly:O app só mostra o quanto falta: a meta é sua. De ${limits.min}:min: a ${limits.max}:max: treinos.`;
    }
    return $localize`:@@training.progress.goal.hint-e1rm:A meta aparece como uma linha tracejada no gráfico de 1RM. Use quilos, como 55 ou 42,5.`;
  });

  /** O texto do campo: o que a pessoa digitou, ou o valor atual (com vírgula) na primeira vez. */
  protected readonly text = computed(() => {
    const typed = this.draft();
    if (typed !== null) return typed;
    const current = this.current();
    return current === null ? '' : String(current).replace('.', ',');
  });

  protected async save(): Promise<void> {
    const kind = this.kind();
    const raw = this.text().trim().replace(',', '.');
    const value = raw === '' ? NaN : Number(raw);
    if (!Number.isFinite(value)) {
      this.error.set(
        $localize`:@@training.progress.goal.not-a-number:Digite um número, como 55 ou 42,5.`,
      );
      return;
    }
    if (kind === 'weekly_sessions' && !Number.isInteger(value)) {
      this.error.set(
        $localize`:@@training.progress.goal.not-integer:Use um número inteiro de treinos.`,
      );
      return;
    }

    const result = await this.goals.set(kind, value, this.exerciseId());
    switch (result.status) {
      case 'saved':
        this.sheet().close();
        return;
      case 'invalid':
        this.error.set(this.issueText(result.issues));
        return;
      case 'storage-full':
        this.error.set(this.storageText());
        return;
      case 'not-found':
        this.sheet().close();
        return;
    }
  }

  protected async remove(): Promise<void> {
    const result = await this.goals.clear(this.kind(), this.exerciseId());
    if (result.status === 'storage-full') {
      this.error.set(this.storageText());
      return;
    }
    this.sheet().close();
  }

  private issueText(issues: readonly GoalIssue[]): string {
    const code = issues[0]?.code;
    if (code === 'value-decimals') {
      return $localize`:@@training.progress.goal.decimals:Use no máximo duas casas decimais.`;
    }
    const limits = GOAL_LIMITS[this.kind()];
    if (this.kind() === 'weekly_sessions') {
      return $localize`:@@training.progress.goal.range-weekly:Use de ${limits.min}:min: a ${limits.max}:max: treinos por semana.`;
    }
    const max = new Intl.NumberFormat('pt-BR').format(limits.max);
    return $localize`:@@training.progress.goal.range-e1rm:Use de ${limits.min}:min: a ${max}:max: kg.`;
  }

  private storageText(): string {
    return $localize`:@@training.progress.goal.storage:Sem espaço no aparelho para guardar a mudança. Libere espaço e tente de novo.`;
  }
}
