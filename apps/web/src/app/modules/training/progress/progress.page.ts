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
import { CatalogRepository } from '../data/catalog/catalog-repository';
import { formatDayMonth } from '../shell/format';
import { type ChipOption } from '../shell/training-chips';
import { TrainingGlyph } from '../shell/training-glyph';
import { OTHER_EXERCISE, ProgressEvolution } from './evolution/evolution-card';
import { ExerciseHistorySheet, type HistoryChoice } from './exercise-history-sheet';
import { ProgressExport } from './export/export-section';
import { ProgressFrequency } from './frequency/frequency-section';
import { ProgressHistory } from './history';
import { ProgressRecords } from './records/records-section';
import { ProgressWeek } from './week/week-section';
import { ProgressSkeleton } from './progress-skeleton';

/** Quantos exercícios aparecem como chips; os demais ficam em "Outro exercício". */
export const CHIP_LIMIT = 6;

/**
 * Aba Progresso: responde "a carga subiu?". O gráfico de evolução de um exercício fica sempre à vista (abre em 1RM
 * estimado, últimas 8 semanas) e o resto espera um toque, em seções que se abrem: recordes, semana (volume por músculo),
 * frequência e exportar. Tudo é lido do banco local, calculado pelo motor de progresso: funciona sem rede.
 *
 * O exercício vem de `?exercise=<id>` (a ficha do exercício aponta para cá); sem ele, vale o treinado mais recentemente.
 * Sem nenhum treino registrado, a tela só explica o que fazer.
 */
@Component({
  selector: 'app-training-progress-page',
  imports: [
    RouterLink,
    TrainingGlyph,
    ProgressEvolution,
    ProgressRecords,
    ProgressWeek,
    ProgressFrequency,
    ProgressExport,
    ExerciseHistorySheet,
    ProgressSkeleton,
  ],
  providers: [ProgressHistory],
  templateUrl: './progress.page.html',
  styleUrl: './progress.page.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ProgressPage {
  private readonly route = inject(ActivatedRoute);
  private readonly catalog = inject(CatalogRepository);
  private readonly history = inject(ProgressHistory);

  private readonly requested = toSignal(
    this.route.queryParamMap.pipe(map((params) => params.get('exercise'))),
    { initialValue: null },
  );

  /** O exercício que a pessoa tocou nos chips ou na folha; ganha do endereço até o endereço mudar. */
  protected readonly picked = signal<string | null>(null);
  protected readonly sheetOpen = signal(false);
  /** Os nomes do catálogo dos exercícios que a tela usa; `null` até a primeira leitura. */
  private readonly names = signal<ReadonlyMap<string, string> | null>(null);
  private ticket = 0;

  protected readonly ready = computed(() => this.history.data() !== null && this.names() !== null);

  /** Os exercícios com histórico que o catálogo conhece, do treinado mais recentemente ao mais antigo. */
  private readonly options = computed(() => {
    const names = this.names();
    const data = this.history.data();
    if (names === null || data === null) return [];
    return data.exercises.flatMap((exercise) => {
      const name = names.get(exercise.id);
      return name === undefined ? [] : [{ id: exercise.id, name, lastAt: exercise.lastAt }];
    });
  });

  /** O exercício do endereço, se o catálogo o conhece (mesmo sem histórico: a ficha aponta para cá antes do primeiro treino). */
  private readonly requestedExercise = computed(() => {
    const id = this.requested();
    const name = id === null ? undefined : this.names()?.get(id);
    return id !== null && name !== undefined ? { id, name } : null;
  });

  protected readonly exercise = computed(() => {
    const picked = this.picked();
    const options = this.options();
    const chosen =
      picked === null ? null : (options.find((option) => option.id === picked) ?? null);
    if (chosen !== null) return { id: chosen.id, name: chosen.name };
    return this.requestedExercise() ?? options[0] ?? null;
  });

  protected readonly chips = computed<readonly ChipOption[]>(() => {
    const options = this.options();
    const shown = options.slice(0, CHIP_LIMIT).map((option) => ({
      id: option.id,
      label: option.name,
    }));
    const current = this.exercise();
    if (current !== null && !shown.some((chip) => chip.id === current.id)) {
      shown.push({ id: current.id, label: current.name });
    }
    if (options.length > CHIP_LIMIT) {
      shown.push({
        id: OTHER_EXERCISE,
        label: $localize`:@@training.progress.exercise.other:Outro Exercício`,
      });
    }
    return shown;
  });

  protected readonly choices = computed<readonly HistoryChoice[]>(() =>
    this.options().map((option) => ({
      id: option.id,
      name: option.name,
      last: formatDayMonth(option.lastAt),
    })),
  );

  constructor() {
    effect(() => {
      this.requested();
      untracked(() => this.picked.set(null));
    });
    effect(() => {
      const data = this.history.data();
      const requested = this.requested();
      this.catalog.revision();
      if (data === null) return;
      untracked(
        () =>
          void this.loadNames(
            data.exercises.map((exercise) => exercise.id),
            requested,
          ),
      );
    });
  }

  protected choose(id: string): void {
    this.picked.set(id);
  }

  private async loadNames(ids: readonly string[], requested: string | null): Promise<void> {
    const ticket = ++this.ticket;
    const wanted = requested === null ? ids : [...new Set([...ids, requested])];
    const found = await Promise.all(wanted.map((id) => this.catalog.get(id)));
    if (ticket !== this.ticket) return;
    const names = new Map<string, string>();
    found.forEach((exercise, index) => {
      if (exercise !== undefined) names.set(wanted[index], exercise.name);
    });
    this.names.set(names);
  }
}
