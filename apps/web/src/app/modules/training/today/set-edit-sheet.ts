import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  linkedSignal,
  output,
  signal,
  viewChild,
} from '@angular/core';
import type { LocalExercise } from '../data/catalog/exercise';
import type { LocalSet } from '../data/sessions/session';
import { TrainingGlyph } from '../shell/training-glyph';
import { TrainingSheet } from '../shell/training-sheet';
import { LiveStore } from './live-store';
import type { SetFields } from './set-draft';
import { LiveSetFields } from './set-fields';
import { setText } from './today-text';

/**
 * Folha "Editar série": muda carga, repetições, esforço e anotação de uma série já gravada (também a de um treino
 * encerrado) ou a apaga. Apagar pede confirmação na própria folha, porque a série some do treino e dos recordes.
 */
@Component({
  selector: 'app-set-edit-sheet',
  imports: [TrainingSheet, TrainingGlyph, LiveSetFields],
  template: `
    <app-training-sheet [heading]="heading" [dismissLabel]="cancelLabel" (closed)="closed.emit()">
      <button
        sheetAction
        type="button"
        class="secondary ui-btn"
        [disabled]="confirming()"
        (click)="confirming.set(true)"
      >
        <app-training-glyph name="trash" />
        <span i18n="@@training.edit.delete">Apagar</span>
      </button>
      <button sheetAction type="button" class="primary ui-btn" (click)="save()">
        <span i18n="@@training.edit.save">Salvar</span>
      </button>

      @if (exercise(); as current) {
        <p class="what">
          <span class="name">{{ current.name }}</span>
          <span class="was">{{ was() }}</span>
        </p>
        <label class="warm">
          <span i18n="@@training.edit.warmup">Série de aquecimento</span>
          <input
            type="checkbox"
            role="switch"
            class="ui-switch"
            [checked]="fields().warmup"
            (change)="fields.set({ ...fields(), warmup: $any($event.target).checked })"
          />
        </label>
        <app-live-set-fields [exercise]="current" [(value)]="fields" />
      }

      @if (error()) {
        <p class="ui-notice bad" role="alert">
          <app-training-glyph name="alert" />
          <span>{{ error() }}</span>
        </p>
      }
      @if (confirming()) {
        <div class="ui-notice warn" role="group" [attr.aria-label]="confirmLabel">
          <app-training-glyph name="alert" />
          <div class="confirm">
            <p i18n="@@training.edit.confirm">
              Apagar esta série? Ela some do treino e dos recordes.
            </p>
            <div class="confirm-actions">
              <button type="button" class="danger ui-btn" (click)="remove()">
                <span i18n="@@training.edit.confirm-yes">Sim, Apagar</span>
              </button>
              <button type="button" class="secondary ui-btn" (click)="confirming.set(false)">
                <span i18n="@@training.edit.confirm-no">Manter</span>
              </button>
            </div>
          </div>
        </div>
      }
    </app-training-sheet>
  `,
  styleUrl: './set-edit-sheet.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SetEditSheet {
  private readonly live = inject(LiveStore);
  private readonly sheet = viewChild.required(TrainingSheet);

  readonly set = input.required<LocalSet>();
  readonly exercise = input<LocalExercise | undefined>(undefined);

  /** Salvou ou apagou (a tela já releu o treino). */
  readonly changed = output<void>();
  readonly closed = output<void>();

  protected readonly heading = $localize`:@@training.edit.title:Editar Série`;
  protected readonly cancelLabel = $localize`:@@training.edit.cancel:Cancelar`;
  protected readonly confirmLabel = $localize`:@@training.edit.confirm-label:Confirmar apagar a série`;

  /** Os campos começam com o que a série tem hoje; a folha só existe enquanto ela está aberta. */
  protected readonly fields = linkedSignal<SetFields>(() => {
    const set = this.set();
    return {
      weightKg: set.weightKg,
      reps: set.reps,
      durationS: set.durationS,
      rpe: set.rpe,
      warmup: set.setType === 'warmup',
      note: set.note,
    };
  });
  protected readonly confirming = signal(false);
  protected readonly error = signal('');
  protected readonly was = computed(() => {
    const exercise = this.exercise();
    return exercise ? setText(this.set(), exercise.recordType) : '';
  });

  protected async save(): Promise<void> {
    const failure = await this.live.editSet(this.set(), this.fields());
    if (failure !== null) {
      this.error.set(failure);
      return;
    }
    this.changed.emit();
    this.sheet().close();
  }

  protected async remove(): Promise<void> {
    if (await this.live.deleteSet(this.set().id)) {
      this.changed.emit();
      this.sheet().close();
      return;
    }
    this.confirming.set(false);
    this.error.set($localize`:@@training.edit.delete-failed:Não foi possível apagar a série.`);
  }
}
