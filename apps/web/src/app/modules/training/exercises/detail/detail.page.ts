import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { map } from 'rxjs';
import { ConnectivityService } from '../../../../core/connectivity/connectivity.service';
import { CatalogRepository } from '../../data/catalog/catalog-repository';
import { CatalogWriter } from '../../data/catalog/catalog-writer';
import type { LocalExercise } from '../../data/catalog/exercise';
import { ProgressRepository } from '../../data/progress/progress-repository';
import { RoutineRepository } from '../../data/routines/routine-repository';
import type { LocalRoutine } from '../../data/routines/routine';
import { TrainingSync } from '../../data/sync/training-sync';
import type { PersonalRecords } from '../../domain/progress/records';
import type { DailyPoint } from '../../domain/progress/series';
import type { MuscleId } from '../../domain/taxonomy';
import {
  DEFAULT_STEP_KG,
  effectiveStepKg,
  equipmentLabel,
  isEquipmentId,
  isMuscleId,
  muscleLabel,
  recordTypeLabel,
} from '../../domain/taxonomy';
import { ExerciseIllustration } from '../../illustrations/exercise-illustration';
import { illustrationFor } from '../../illustrations/illustration-map';
import { BackNavigation } from '../../shell/back-navigation';
import { awaitingFirstPull } from '../../shell/first-pull';
import { formatDayMonth, formatKg } from '../../shell/format';
import { TrainingGlyph } from '../../shell/training-glyph';
import { TrainingSheet } from '../../shell/training-sheet';
import { ExerciseMuscles } from './exercise-muscles';

/** Quantos passos de "Como fazer" aparecem antes do "Ver todos". */
export const STEPS_PREVIEW = 3;
/** Quantos dias recentes o histórico da ficha mostra. */
export const HISTORY_DAYS = 3;

export interface HistoryRow {
  readonly day: string;
  readonly kg: number;
  readonly reps: number | null;
  readonly record: boolean;
}

/** Os últimos dias com a melhor série de cada um, do mais novo ao mais velho, marcando o dia que bateu a carga máxima. */
export function historyRows(points: readonly DailyPoint[], limit = HISTORY_DAYS): HistoryRow[] {
  let best = 0;
  const rows: HistoryRow[] = [];
  for (const point of points) {
    if (point.topWeightKg === null) continue;
    rows.push({
      day: formatDayMonth(point.at),
      kg: point.topWeightKg,
      reps: point.topWeightReps,
      record: point.topWeightKg > best,
    });
    best = Math.max(best, point.topWeightKg);
  }
  return rows.slice(-limit).reverse();
}

/**
 * Ficha do exercício. Uma ação principal ("Adicionar a um treino") logo depois do cabeçalho; o resto é leitura:
 * como fazer, o histórico do próprio usuário e, atrás de linhas próprias, o salto de carga e (só no exercício
 * próprio) editar e apagar. Tudo lido do banco local, sem rede.
 */
@Component({
  selector: 'app-exercise-detail-page',
  imports: [RouterLink, TrainingGlyph, TrainingSheet, ExerciseIllustration, ExerciseMuscles],
  templateUrl: './detail.page.html',
  styleUrl: './detail.page.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ExerciseDetailPage {
  private readonly catalog = inject(CatalogRepository);
  private readonly writer = inject(CatalogWriter);
  private readonly progress = inject(ProgressRepository);
  private readonly routines = inject(RoutineRepository);
  private readonly back = inject(BackNavigation);
  private readonly route = inject(ActivatedRoute);
  private readonly sync = inject(TrainingSync);
  private readonly connectivity = inject(ConnectivityService);

  private readonly id = toSignal(
    this.route.paramMap.pipe(map((params) => params.get('id') ?? '')),
    {
      initialValue: '',
    },
  );

  /** `undefined`: ainda lendo · `null`: não existe (ou foi apagado). */
  protected readonly exercise = signal<LocalExercise | null | undefined>(undefined);
  protected readonly records = signal<PersonalRecords | null>(null);
  protected readonly history = signal<readonly HistoryRow[]>([]);
  protected readonly routineList = signal<readonly LocalRoutine[]>([]);

  protected readonly stepsOpen = signal(false);
  protected readonly addOpen = signal(false);
  protected readonly addError = signal('');
  protected readonly added = signal<LocalRoutine | null>(null);
  protected readonly stepEditing = signal(false);
  protected readonly stepDraft = signal('');
  protected readonly stepError = signal('');
  protected readonly confirmingDelete = signal(false);
  protected readonly saveError = signal('');

  protected readonly own = computed(() => this.exercise()?.source === 'own');
  protected readonly hasArt = computed(() => {
    const exercise = this.exercise();
    return exercise ? illustrationFor(exercise.slug) !== undefined : false;
  });
  protected readonly hasHistory = computed(
    () => (this.records()?.maxWeight ?? null) !== null || this.history().length > 0,
  );
  protected readonly primaryMuscles = computed(
    () => this.exercise()?.primaryMuscles.filter(isMuscleId) ?? [],
  );
  protected readonly secondaryMuscles = computed<readonly MuscleId[]>(() => {
    const exercise = this.exercise();
    return exercise ? exercise.secondaryMuscles.filter(isMuscleId) : [];
  });

  protected readonly chips = computed(() => {
    const exercise = this.exercise();
    if (!exercise) return [];
    const [primary, ...extraPrimary] = exercise.primaryMuscles;
    const list: { text: string; accent: boolean }[] = [];
    if (primary) list.push({ text: muscleLabel(primary), accent: true });
    for (const id of [...extraPrimary, ...exercise.secondaryMuscles]) {
      const name = muscleLabel(id);
      list.push({
        text: $localize`:@@training.detail.secondary:${name}:name: · secundário`,
        accent: false,
      });
    }
    list.push({ text: equipmentLabel(exercise.equipment), accent: false });
    // O tipo comum (carga e repetições) não precisa de chip: só o que foge dele merece aparecer.
    if (exercise.recordType !== 'weight_reps') {
      list.push({ text: recordTypeLabel(exercise.recordType), accent: false });
    }
    return list;
  });

  protected readonly steps = computed(() => this.exercise()?.instructions ?? []);
  protected readonly visibleSteps = computed(() =>
    this.stepsOpen() ? this.steps() : this.steps().slice(0, STEPS_PREVIEW),
  );
  protected readonly stepsHidden = computed(() => this.steps().length - this.visibleSteps().length);

  protected readonly stepText = computed(() => {
    const exercise = this.exercise();
    const step = exercise ? effectiveStepKg(exercise) : 0;
    return step > 0 ? formatKg(step) : '';
  });
  protected readonly stepSource = computed(() => {
    const exercise = this.exercise();
    if (!exercise) return '';
    if (exercise.stepKg !== null)
      return $localize`:@@training.detail.step-custom:ajustado por você`;
    if (isEquipmentId(exercise.equipment) && DEFAULT_STEP_KG[exercise.equipment] > 0) {
      const equipment = equipmentLabel(exercise.equipment).toLowerCase();
      return $localize`:@@training.detail.step-default:padrão de ${equipment}:equipment:`;
    }
    return $localize`:@@training.detail.step-none:sem salto sugerido`;
  });

  protected readonly stepsPreview = STEPS_PREVIEW;
  protected readonly backLabel = $localize`:@@training.detail.back:Voltar para Exercícios`;
  protected readonly chipsLabel = $localize`:@@training.detail.chips:Músculos e equipamento`;
  protected readonly addHeading = $localize`:@@training.detail.add-heading:Adicionar a um treino`;
  protected readonly cancelLabel = $localize`:@@training.detail.add-cancel:Cancelar`;

  private ticket = 0;

  constructor() {
    effect(() => {
      const id = this.id();
      this.catalog.revision();
      const waiting = awaitingFirstPull(this.sync, this.connectivity);
      untracked(() => void this.load(id, waiting));
    });
  }

  protected goBack(): void {
    this.back.back('/treino/exercicios');
  }

  protected maxWeightText(): string {
    const record = this.records()?.maxWeight;
    return record ? formatKg(record.weightKg) : '';
  }

  protected oneRepMaxText(): string {
    const record = this.records()?.oneRepMax;
    return record ? formatKg(Math.round(record.valueKg * 10) / 10) : '';
  }

  protected rowText(row: HistoryRow): string {
    return row.reps === null ? formatKg(row.kg) : `${formatKg(row.kg)} × ${row.reps}`;
  }

  protected toggleSteps(): void {
    this.stepsOpen.update((open) => !open);
  }

  // ---- adicionar a um treino ----

  protected async openAdd(): Promise<void> {
    this.addError.set('');
    this.routineList.set(await this.routines.list());
    this.addOpen.set(true);
  }

  protected closeAdd(): void {
    this.addOpen.set(false);
  }

  protected async addTo(routine: LocalRoutine): Promise<void> {
    const exercise = this.exercise();
    if (!exercise) return;
    const result = await this.routines.addExercise(routine.id, exercise.id);
    switch (result.status) {
      case 'saved':
        this.added.set(result.routine);
        this.addOpen.set(false);
        return;
      case 'routine-full':
        this.addError.set(
          $localize`:@@training.detail.add-full:Essa rotina já está com o máximo de exercícios.`,
        );
        return;
      case 'storage-full':
        this.addError.set(
          $localize`:@@training.detail.add-storage:Sem espaço no aparelho para guardar a mudança. Libere espaço e tente de novo.`,
        );
        return;
      case 'not-found':
        this.addError.set($localize`:@@training.detail.add-missing:Essa rotina não existe mais.`);
        this.routineList.set(await this.routines.list());
        return;
    }
  }

  protected routineSummary(routine: LocalRoutine): string {
    const count = routine.items.length;
    return count === 1
      ? $localize`:@@training.routines.exercises-one:1 exercício`
      : $localize`:@@training.routines.exercises-many:${count}:count: exercícios`;
  }

  protected routineLetter(index: number): string {
    return String.fromCharCode(65 + (index % 26));
  }

  // ---- salto de carga ----

  protected startStepEdit(): void {
    const exercise = this.exercise();
    if (!exercise) return;
    this.stepDraft.set(String(effectiveStepKg(exercise)).replace('.', ','));
    this.stepError.set('');
    this.stepEditing.set(true);
  }

  protected cancelStepEdit(): void {
    this.stepEditing.set(false);
  }

  protected async saveStep(value: number | null): Promise<void> {
    const exercise = this.exercise();
    if (!exercise) return;
    if (value !== null && (!Number.isFinite(value) || value < 0 || value > 100)) {
      this.stepError.set(
        $localize`:@@training.detail.step-invalid:Use um número de 0 a 100, como 2,5.`,
      );
      return;
    }
    const result = await this.writer.setStepKg(exercise.id, value);
    if (result.status === 'storage-full') {
      this.stepError.set(
        $localize`:@@training.detail.save-storage:Sem espaço no aparelho para guardar a mudança. Libere espaço e tente de novo.`,
      );
      return;
    }
    this.stepEditing.set(false);
  }

  protected saveStepFromDraft(): void {
    // Campo vazio vira NaN e cai na mensagem de número inválido, como qualquer texto que não seja número.
    const text = this.stepDraft().trim().replace(',', '.');
    void this.saveStep(text === '' ? NaN : Number(text));
  }

  protected useDefaultStep(): void {
    void this.saveStep(null);
  }

  // ---- apagar (exercício próprio) ----

  protected askDelete(): void {
    this.confirmingDelete.set(true);
  }

  protected keepExercise(): void {
    this.confirmingDelete.set(false);
  }

  protected async deleteExercise(): Promise<void> {
    const exercise = this.exercise();
    if (!exercise) return;
    const result = await this.writer.deleteCustomExercise(exercise.id);
    if (result.status === 'storage-full') {
      this.saveError.set(
        $localize`:@@training.detail.delete-storage:Sem espaço no aparelho para guardar a mudança. Libere espaço e tente de novo.`,
      );
      this.confirmingDelete.set(false);
      return;
    }
    this.back.back('/treino/exercicios');
  }

  private async load(id: string, waitingForServer: boolean): Promise<void> {
    const ticket = ++this.ticket;
    const exercise = (await this.catalog.get(id)) ?? null;
    if (ticket !== this.ticket) return;
    // Aberta direto pelo endereço na primeira vez, a ficha espera a primeira passada do servidor em vez de acusar "não achado".
    this.exercise.set(exercise === null && waitingForServer ? undefined : exercise);
    if (!exercise) return;
    const [records, series] = await Promise.all([
      this.progress.records(exercise.id),
      this.progress.exerciseSeries(exercise.id, 'all'),
    ]);
    if (ticket !== this.ticket) return;
    this.records.set(records);
    this.history.set(historyRows(series.points));
  }
}
