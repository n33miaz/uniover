import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  untracked,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import type { LocalExercise } from '../../data/catalog/exercise';
import { MuscleId, equipmentLabel, muscleLabel } from '../../domain/taxonomy';
import { TrainingGlyph } from '../../shell/training-glyph';
import { LastSetLabels } from '../last-set-labels';
import { weekSetsText } from './body-map-text';

/** Quantos exercícios o painel lista; o resto está atrás do "Ver todos". */
export const PANEL_ROWS = 3;

let nextPanelId = 0;

/**
 * O painel do músculo escolhido: o nome, as séries da semana, os primeiros exercícios e o caminho para a lista inteira já
 * filtrada. Um músculo por vez. A contagem de séries aparece em texto (a cor do desenho nunca vai sozinha), e "nenhuma série
 * nesta semana" é só um fato, sem tom de alerta.
 */
@Component({
  selector: 'app-body-panel',
  imports: [RouterLink, TrainingGlyph],
  templateUrl: './body-panel.html',
  styleUrl: './body-panel.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BodyPanel {
  private readonly lastSets = inject(LastSetLabels);

  readonly muscle = input.required<MuscleId>();
  /** Todos os exercícios do músculo, por nome (o painel mostra os primeiros). */
  readonly exercises = input.required<readonly LocalExercise[]>();
  /** Séries de trabalho do músculo na semana. */
  readonly weekSets = input.required<number>();

  protected readonly titleId = `body-panel-title-${nextPanelId++}`;
  protected readonly name = computed(() => muscleLabel(this.muscle()));
  protected readonly shown = computed(() => this.exercises().slice(0, PANEL_ROWS));
  protected readonly queryParams = computed(() => ({ muscle: this.muscle() }));

  protected readonly setsText = computed(() => weekSetsText(this.weekSets()));

  protected readonly allText = computed(() => {
    const total = this.exercises().length;
    return $localize`:@@training.map.all:Ver todos (${total}:total:)`;
  });

  protected readonly labels = this.lastSets.labels;

  constructor() {
    // O "seu último" só é lido para as linhas que aparecem.
    effect(() => {
      const visible = this.shown();
      untracked(() => this.lastSets.request(visible));
    });
  }

  /** Equipamento e, quando há, o "seu último"; sem registro a linha não diz nada (o painel é para olhar, não para cobrar). */
  protected support(exercise: LocalExercise): string {
    const last = this.labels().get(exercise.id);
    const equipment = equipmentLabel(exercise.equipment);
    return last
      ? $localize`:@@training.map.row-support:${equipment}:equipment: · seu último: ${last}:last:`
      : equipment;
  }
}
