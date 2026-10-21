import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  Injector,
  afterNextRender,
  computed,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Location } from '@angular/common';
import { ActivatedRoute } from '@angular/router';
import { ConnectivityService } from '../../../../core/connectivity/connectivity.service';
import { TrainingSync } from '../../data/sync/training-sync';
import {
  MUSCLE_GROUP_IDS,
  MuscleId,
  muscleGroupLabel,
  muscleLabel,
  musclesOfGroup,
} from '../../domain/taxonomy';
import { PrefersReducedMotion } from '../../illustrations/prefers-reduced-motion';
import { BackNavigation } from '../../shell/back-navigation';
import { awaitingFirstPull } from '../../shell/first-pull';
import { TrainingGlyph } from '../../shell/training-glyph';
import { LastSetLabels } from '../last-set-labels';
import { BodyFigure, FigureZone } from './body-figure';
import { BodyMapData } from './body-map-data';
import { parseBodyMapParams, toBodyMapQuery } from './body-map-params';
import { exercisesText, exercisesUnitText, weekSetsText } from './body-map-text';
import { BodyPanel } from './body-panel';
import { BODY_ZONES, BodyFace, faceFor } from './body-zones';
import { rectPath } from './body-shapes';
import { intensityOf, legendSteps } from './muscle-intensity';
import { MuscleList, MuscleListGroup } from './muscle-list';

/**
 * Mapa do corpo: a silhueta (frente ou costas) com um botão por músculo. Tocar num músculo abre, embaixo, o painel com os
 * exercícios dele e as séries da semana; o painel leva à lista de Exercícios já filtrada. A lista de músculos logo abaixo é o
 * caminho completo para quem não acerta a figura. Tudo vem do banco local (sem rede funciona igual).
 *
 * A face e o músculo aberto moram no endereço (`?face=back&muscle=lats`), escritos trocando a entrada do histórico, como a
 * lista de Exercícios faz com os filtros: voltar da lista ou da ficha traz o mapa na mesma face e com o painel aberto.
 */
@Component({
  selector: 'app-training-body-map-page',
  imports: [BodyFigure, BodyPanel, MuscleList, TrainingGlyph],
  providers: [BodyMapData, LastSetLabels],
  templateUrl: './body-map.page.html',
  styleUrl: './body-map.page.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BodyMapPage {
  protected readonly data = inject(BodyMapData);
  private readonly sync = inject(TrainingSync);
  private readonly connectivity = inject(ConnectivityService);
  private readonly route = inject(ActivatedRoute);
  private readonly location = inject(Location);
  private readonly back = inject(BackNavigation);
  private readonly reducedMotion = inject(PrefersReducedMotion);
  private readonly injector = inject(Injector);

  protected readonly face = signal<BodyFace>('front');
  protected readonly muscle = signal<MuscleId | ''>('');
  /** O músculo aberto no painel, ou `null`. */
  protected readonly selected = computed(() => this.muscle() || null);

  private readonly panel = viewChild<unknown, ElementRef<HTMLElement>>('panel', {
    read: ElementRef,
  });

  protected readonly online = this.connectivity.online;
  /** O aparelho está trazendo o catálogo agora, ou ainda vai começar (primeira abertura). */
  protected readonly downloading = computed(
    () => this.sync.pulling() || awaitingFirstPull(this.sync, this.connectivity),
  );
  /** O catálogo ainda não chegou ao aparelho (primeira abertura sem rede, ou o primeiro puxar em andamento). */
  protected readonly catalogEmpty = computed(() => this.data.ready() && this.data.total() === 0);

  protected readonly backLabel = $localize`:@@training.map.back:Voltar para Exercícios`;
  protected readonly facesLabel = $localize`:@@training.map.faces-label:Lado do corpo`;
  protected readonly legend = legendSteps();
  protected readonly legendLabel = $localize`:@@training.map.legend:Séries na semana`;

  protected readonly figureLabel = computed(() =>
    this.face() === 'front'
      ? $localize`:@@training.map.figure-front:Corpo, de frente`
      : $localize`:@@training.map.figure-back:Corpo, de costas`,
  );

  /** As zonas da face à mostra, com a cor (séries na semana), o rótulo e a escolha. */
  protected readonly zones = computed<FigureZone[]>(() => {
    const selected = this.muscle();
    return BODY_ZONES[this.face()].map((zone) => ({
      muscle: zone.muscle,
      shapes: zone.shapes,
      tiles: zone.tiles.map(rectPath),
      level: intensityOf(this.data.weekSets(zone.muscle)),
      label: this.zoneLabel(zone.muscle),
      selected: zone.muscle === selected,
    }));
  });

  /** Todos os músculos da taxonomia, por grupo: o caminho completo, que não depende de acertar o desenho. */
  protected readonly listGroups = computed<MuscleListGroup[]>(() => {
    const selected = this.muscle();
    return MUSCLE_GROUP_IDS.map((group) => ({
      id: group,
      label: muscleGroupLabel(group),
      muscles: musclesOfGroup(group).map((id) => {
        const count = this.data.exerciseCount(id);
        const label = muscleLabel(id);
        return {
          id,
          label,
          count,
          unit: exercisesUnitText(count),
          selected: id === selected,
        };
      }),
    }));
  });

  /** O que o leitor de tela ouve ao escolher um músculo (o foco fica na zona ou no botão tocado). */
  protected readonly announcement = computed(() => {
    const muscle = this.muscle();
    if (muscle === '') return '';
    const name = muscleLabel(muscle);
    return $localize`:@@training.map.announce:${name}:muscle:: ${exercisesText(this.data.exerciseCount(muscle))}:exercises:, ${weekSetsText(this.data.weekSets(muscle))}:sets:`;
  });

  constructor() {
    // O endereço que chega de fora: a primeira abertura, um link ou o botão "voltar". O que a própria tela escreve
    // (`mirror`) não passa pelo roteador e por isso não volta por aqui.
    this.route.queryParamMap.pipe(takeUntilDestroyed()).subscribe((map) => {
      const incoming = parseBodyMapParams(map);
      this.face.set(incoming.face);
      this.muscle.set(incoming.muscle);
    });
  }

  protected showFace(face: BodyFace): void {
    this.face.set(face);
    this.mirror();
  }

  /** Escolher o músculo já aberto o fecha. Um músculo que só aparece na outra face vira a figura para ela. */
  protected pick(muscle: MuscleId): void {
    const next = this.muscle() === muscle ? '' : muscle;
    this.muscle.set(next);
    if (next !== '') {
      this.face.set(faceFor(next, this.face()));
      this.revealPanel();
    }
    this.mirror();
  }

  protected retryDownload(): void {
    void this.sync.pullNow();
  }

  protected goBack(): void {
    this.back.back('/treino/exercicios');
  }

  private zoneLabel(muscle: MuscleId): string {
    const name = muscleLabel(muscle);
    return $localize`:@@training.map.zone-label:${name}:muscle:, ${exercisesText(this.data.exerciseCount(muscle))}:exercises:, ${weekSetsText(this.data.weekSets(muscle))}:sets:`;
  }

  /**
   * O painel abre abaixo da figura e, num celular baixo, pode ficar fora da tela: rola o mínimo para ele aparecer inteiro
   * (a lista de músculos, lá embaixo, também abre o painel que está acima dela). Sem movimento se a pessoa pediu menos.
   */
  private revealPanel(): void {
    afterNextRender(
      () =>
        this.panel()?.nativeElement.scrollIntoView({
          block: 'nearest',
          behavior: this.reducedMotion.reduced() ? 'auto' : 'smooth',
        }),
      { injector: this.injector },
    );
  }

  /** Escreve a face e o músculo no endereço, trocando a entrada do histórico em vez de somar outra (ver a lista de Exercícios). */
  private mirror(): void {
    const path = this.location.path().split('?')[0];
    const query = toBodyMapQuery({ face: this.face(), muscle: this.muscle() });
    this.location.replaceState(path, query, this.location.getState());
  }
}
