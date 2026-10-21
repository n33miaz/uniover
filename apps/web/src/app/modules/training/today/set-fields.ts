import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  Injector,
  afterNextRender,
  computed,
  inject,
  input,
  model,
  signal,
  viewChild,
} from '@angular/core';
import type { LocalExercise } from '../data/catalog/exercise';
import { TrainingGlyph } from '../shell/training-glyph';
import {
  DURATION_STEP_S,
  NOTE_MAX,
  REPS_STEP,
  RPE_CHOICES,
  type SetFields,
  formatField,
  loadStepFor,
} from './set-draft';
import { LiveStepper } from './stepper';

let nextFieldsId = 0;

/**
 * Os campos de uma série: carga e repetições com − e + (só repetições, ou a duração, conforme o exercício), o esforço
 * percebido (RPE, opcional e desmarcável) e a anotação (atrás de um toque). É o miolo do cartão da série atual e da folha
 * de editar uma série já feita; quem usa liga o valor por `[(value)]`.
 */
@Component({
  selector: 'app-live-set-fields',
  imports: [LiveStepper, TrainingGlyph],
  template: `
    <div class="fields">
      @switch (exercise().recordType) {
        @case ('time') {
          <app-live-stepper
            [label]="durationLabel"
            [hint]="durationHint"
            [value]="value().durationS"
            [step]="durationStep"
            [max]="86400"
            [lessLabel]="durationLess"
            [moreLabel]="durationMore"
            [invalid]="issue() === 'duration'"
            (valueChange)="patch({ durationS: $event })"
          />
        }
        @case ('reps_only') {
          <app-live-stepper
            [label]="repsLabel"
            [hint]="repsHint()"
            [value]="value().reps"
            [step]="repsStep"
            [max]="999"
            [lessLabel]="repsLess"
            [moreLabel]="repsMore"
            [invalid]="issue() === 'reps'"
            (valueChange)="patch({ reps: $event })"
          />
        }
        @default {
          <app-live-stepper
            [label]="loadLabel"
            [hint]="loadHint()"
            [decimal]="true"
            [value]="value().weightKg"
            [step]="loadStep()"
            [max]="99999"
            [lessLabel]="loadLess"
            [moreLabel]="loadMore"
            [invalid]="issue() === 'weight'"
            (valueChange)="patch({ weightKg: $event })"
          />
          <app-live-stepper
            [label]="repsLabel"
            [hint]="repsHint()"
            [value]="value().reps"
            [step]="repsStep"
            [max]="999"
            [lessLabel]="repsLess"
            [moreLabel]="repsMore"
            [invalid]="issue() === 'reps'"
            (valueChange)="patch({ reps: $event })"
          />
        }
      }

      <div class="rpe" role="group" [attr.aria-labelledby]="rpeId">
        <span class="rpe-label" [id]="rpeId">
          <span i18n="@@training.live.rpe">Esforço (RPE)</span>
          <span class="optional" i18n="@@training.live.optional">opcional</span>
        </span>
        <div class="rpe-row">
          @for (choice of rpeChoices; track choice) {
            <button
              type="button"
              class="rpe-button"
              [attr.aria-pressed]="value().rpe === choice"
              (click)="toggleRpe(choice)"
            >
              {{ choice }}
            </button>
          }
        </div>
      </div>

      @if (noteOpen()) {
        <div class="note">
          <label [for]="noteId" class="note-label" i18n="@@training.live.note-label"
            >Anotação da série</label
          >
          <textarea
            #noteField
            [id]="noteId"
            class="note-field"
            rows="2"
            [attr.maxlength]="noteMax"
            [value]="value().note"
            (focus)="opened.set(true)"
            (input)="patch({ note: $any($event.target).value })"
          ></textarea>
          @if (value().note.length > noteMax - 50) {
            <span class="note-count" aria-hidden="true"
              >{{ value().note.length }}/{{ noteMax }}</span
            >
          }
        </div>
      } @else {
        <button type="button" class="note-open" (click)="openNote()">
          <app-training-glyph name="pencil" />
          <span i18n="@@training.live.note-open">Anotação</span>
        </button>
      }
    </div>
  `,
  styleUrl: './set-fields.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LiveSetFields {
  readonly exercise = input.required<LocalExercise>();
  readonly value = model.required<SetFields>();
  /** O campo que a última tentativa de gravar recusou (ganha a borda de erro). */
  readonly issue = input<'weight' | 'reps' | 'duration' | null>(null);

  protected readonly rpeChoices = RPE_CHOICES;
  protected readonly noteMax = NOTE_MAX;
  protected readonly repsStep = REPS_STEP;
  protected readonly durationStep = DURATION_STEP_S;
  protected readonly rpeId = `live-rpe-${nextFieldsId}`;
  protected readonly noteId = `live-note-${nextFieldsId++}`;

  /** A pessoa abriu a anotação (o campo fica aberto mesmo vazio). */
  protected readonly opened = signal(false);
  /** A anotação também aparece aberta quando já tem texto (por exemplo, ao editar uma série anotada). */
  protected readonly noteOpen = computed(() => this.opened() || this.value().note !== '');
  private readonly injector = inject(Injector);
  private readonly noteField = viewChild<ElementRef<HTMLTextAreaElement>>('noteField');

  protected readonly loadStep = computed(() => loadStepFor(this.exercise()));
  protected readonly loadHint = computed(() => {
    const step = formatField(this.loadStep());
    return $localize`:@@training.live.load-hint:kg · salto ${step}:step:`;
  });
  protected readonly repsHint = computed(() => '');

  protected readonly loadLabel = $localize`:@@training.live.load:Carga`;
  protected readonly loadLess = $localize`:@@training.live.load-less:Diminuir a carga`;
  protected readonly loadMore = $localize`:@@training.live.load-more:Aumentar a carga`;
  protected readonly repsLabel = $localize`:@@training.live.reps:Repetições`;
  protected readonly repsLess = $localize`:@@training.live.reps-less:Diminuir as repetições`;
  protected readonly repsMore = $localize`:@@training.live.reps-more:Aumentar as repetições`;
  protected readonly durationLabel = $localize`:@@training.live.duration:Duração`;
  protected readonly durationHint = $localize`:@@training.live.duration-hint:segundos`;
  protected readonly durationLess = $localize`:@@training.live.duration-less:Diminuir a duração`;
  protected readonly durationMore = $localize`:@@training.live.duration-more:Aumentar a duração`;

  protected openNote(): void {
    this.opened.set(true);
    // O botão sai do lugar do campo: o foco vai junto, para quem usa teclado ou leitor de tela.
    afterNextRender(() => this.noteField()?.nativeElement.focus(), { injector: this.injector });
  }

  protected patch(change: Partial<SetFields>): void {
    this.value.update((current) => ({ ...current, ...change }));
  }

  protected toggleRpe(choice: number): void {
    this.patch({ rpe: this.value().rpe === choice ? null : choice });
  }
}
