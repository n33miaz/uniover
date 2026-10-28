import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';
import type { MuscleId } from '../domain/taxonomy';
import type { LocalBodyEntry } from '../data/body/body-entry';
import { BodyFigure, type FigureZone } from '../exercises/body-map/body-figure';
import { BODY_ZONES, type BodyFace } from '../exercises/body-map/body-zones';
import { rectPath } from '../exercises/body-map/body-shapes';
import {
  SYMMETRY_RELEVANT_CM,
  bodyMapSignals,
  type BodyMapChange,
  type BodyMapRegion,
  type BodyMapSignal,
} from '../domain/body/body-map-signals';
import { formatCm, toFieldText } from './body-text';

/**
 * Músculo da silhueta → região medida. A circunferência do braço cobre bíceps e tríceps; a da coxa, frente e costas: por
 * isso a mesma região também pinta a zona das costas. Músculo fora daqui não é desenhado (não tem medida para pintar).
 */
const MUSCLE_REGION: ReadonlyMap<MuscleId, BodyMapRegion> = new Map<MuscleId, BodyMapRegion>([
  ['chest', 'chest'],
  ['abdominals', 'abdomen'],
  ['biceps', 'arm'],
  ['triceps', 'arm'],
  ['forearms', 'forearm'],
  ['quadriceps', 'thigh'],
  ['hamstrings', 'thigh'],
  ['calves', 'calf'],
]);

/** Degrau de cor da figura para cada evolução (0 vazio, 1 menor, 2 igual, 3 maior); a legenda repete as mesmas cores. */
const LEVEL: Readonly<Record<BodyMapChange, 0 | 1 | 2 | 3>> = {
  neutral: 0,
  down: 1,
  same: 2,
  up: 3,
};

/**
 * O Mapa do Corpo dentro da tela Corpo: a silhueta pintada pela evolução de cada região desde a medição anterior e, logo
 * abaixo, a simetria entre o lado direito e o esquerdo. Tocar numa região (na figura ou no cartão de simetria) pede o
 * histórico dela. Com uma medição só, o mapa fica neutro e diz o que falta; nunca desenha evolução que não existe.
 */
@Component({
  selector: 'app-body-map-panel',
  imports: [BodyFigure],
  template: `
    <section class="map ui-card" aria-labelledby="body-map-title">
      <div class="heading">
        <h2 id="body-map-title" i18n="@@training.body.map.title">Mapa do Corpo</h2>
        <div
          class="faces"
          role="group"
          i18n-aria-label="@@training.body.map.face-label"
          aria-label="Face da silhueta"
        >
          <button
            type="button"
            [attr.aria-pressed]="face() === 'front'"
            (click)="face.set('front')"
            i18n="@@training.body.map.front"
          >
            Frente
          </button>
          <button
            type="button"
            [attr.aria-pressed]="face() === 'back'"
            (click)="face.set('back')"
            i18n="@@training.body.map.back"
          >
            Costas
          </button>
        </div>
      </div>
      <app-body-figure
        [zones]="zones()"
        [face]="face()"
        [label]="figureLabel()"
        (picked)="pick($event)"
      />
      @if (hasEvolution()) {
        <ul
          class="legend"
          i18n-aria-label="@@training.body.map.legend-label"
          aria-label="Legenda do mapa"
        >
          <li>
            <span class="swatch" data-level="3" aria-hidden="true"></span
            ><span i18n="@@training.body.map.change.up">Cresceu</span>
          </li>
          <li>
            <span class="swatch" data-level="2" aria-hidden="true"></span
            ><span i18n="@@training.body.map.change.same">Igual</span>
          </li>
          <li>
            <span class="swatch" data-level="1" aria-hidden="true"></span
            ><span i18n="@@training.body.map.change.down">Diminuiu</span>
          </li>
        </ul>
      } @else {
        <p class="hint" i18n="@@training.body.map.neutral">
          Sem comparação ainda. Registre outra medição para ver a evolução.
        </p>
      }
      <p class="scope" i18n="@@training.body.map.scope">
        Cintura, Pescoço, Quadril e Dobras aparecem em Registros; não mudam a silhueta.
      </p>
      @if (sidedSignals().length > 0) {
        <h3 class="sub" i18n="@@training.body.map.symmetry">Direito × Esquerdo</h3>
        <div class="symmetry">
          @for (item of sidedSignals(); track item.region) {
            <button
              type="button"
              class="side-card"
              [class.relevant]="isRelevant(item)"
              (click)="history.emit(item.region)"
            >
              <span class="side-name">{{ regionLabel(item.region) }}</span>
              @if (item.symmetry; as pair) {
                <span class="side-values" aria-hidden="true">
                  <span i18n="@@training.body.map.side-right-short"
                    >D {{ number(pair.rightCm) }}</span
                  >
                  <span i18n="@@training.body.map.side-left-short"
                    >E {{ number(pair.leftCm) }}</span
                  >
                </span>
                <small class="side-note" aria-hidden="true">{{ differenceText(item) }}</small>
                <span class="ui-visually-hidden">{{ spokenSymmetry(item) }}</span>
              } @else {
                <small class="side-note" i18n="@@training.body.map.side-missing"
                  >Registre os dois lados</small
                >
              }
            </button>
          }
        </div>
      }
    </section>
  `,
  styleUrl: './body-map-panel.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BodyMapPanel {
  /** As medições locais, da mais antiga à mais nova. */
  readonly entries = input.required<readonly LocalBodyEntry[]>();
  /** A região tocada, para a tela abrir o histórico dela. */
  readonly history = output<BodyMapRegion>();
  protected readonly face = signal<BodyFace>('front');
  protected readonly signals = computed(() => bodyMapSignals(this.entries()));
  protected readonly hasEvolution = computed(() =>
    this.signals().some((item) => item.change !== 'neutral'),
  );
  protected readonly sidedSignals = computed(() => this.signals().filter((item) => item.hasSides));
  protected readonly figureLabel = computed(() =>
    this.face() === 'front'
      ? $localize`:@@training.body.map.figure-front:Mapa do corpo, de frente`
      : $localize`:@@training.body.map.figure-back:Mapa do corpo, de costas`,
  );
  protected readonly zones = computed<FigureZone[]>(() =>
    BODY_ZONES[this.face()].flatMap((zone) => {
      const region = MUSCLE_REGION.get(zone.muscle);
      if (region === undefined) return [];
      const signal = this.signals().find((item) => item.region === region)!;
      return [
        {
          muscle: zone.muscle,
          shapes: zone.shapes,
          tiles: zone.tiles.map(rectPath),
          selected: false,
          level: LEVEL[signal.change],
          label: `${this.regionLabel(region)}: ${this.changeLabel(signal.change)}`,
        },
      ];
    }),
  );

  protected pick(muscle: MuscleId): void {
    const region = MUSCLE_REGION.get(muscle);
    if (region) this.history.emit(region);
  }

  protected number(value: number): string {
    return toFieldText(value);
  }

  protected isRelevant(item: BodyMapSignal): boolean {
    return item.symmetry !== null && item.symmetry.differenceCm > SYMMETRY_RELEVANT_CM;
  }

  protected differenceText(item: BodyMapSignal): string {
    const pair = item.symmetry;
    if (pair === null || !this.isRelevant(item)) {
      return $localize`:@@training.body.map.balanced:Lados próximos`;
    }
    const diff = formatCm(pair.differenceCm);
    return pair.larger === 'right'
      ? $localize`:@@training.body.map.right-larger:D maior ${diff}:diff:`
      : $localize`:@@training.body.map.left-larger:E maior ${diff}:diff:`;
  }

  /**
   * O cartão fala por extenso para o leitor de tela (D e E soltos não se entendem lidos em voz alta). Vai em texto
   * escondido, e não em `aria-label`, para o nome do botão conter o que se vê.
   */
  protected spokenSymmetry(item: BodyMapSignal): string {
    const pair = item.symmetry;
    if (pair === null) return '';
    const right = formatCm(pair.rightCm);
    const left = formatCm(pair.leftCm);
    const note = !this.isRelevant(item)
      ? $localize`:@@training.body.map.spoken.balanced:lados próximos`
      : pair.larger === 'right'
        ? $localize`:@@training.body.map.spoken.right-larger:direito maior em ${formatCm(pair.differenceCm)}:diff:`
        : $localize`:@@training.body.map.spoken.left-larger:esquerdo maior em ${formatCm(pair.differenceCm)}:diff:`;
    return $localize`:@@training.body.map.spoken:direito ${right}:right:, esquerdo ${left}:left:, ${note}:note:. Abrir histórico`;
  }

  protected regionLabel(region: BodyMapRegion): string {
    return {
      chest: $localize`:@@training.body.map.region.chest:Tórax`,
      abdomen: $localize`:@@training.body.map.region.abdomen:Abdômen`,
      arm: $localize`:@@training.body.map.region.arm:Braços`,
      forearm: $localize`:@@training.body.map.region.forearm:Antebraços`,
      thigh: $localize`:@@training.body.map.region.thigh:Coxas`,
      calf: $localize`:@@training.body.map.region.calf:Panturrilhas`,
    }[region];
  }

  private changeLabel(change: BodyMapChange): string {
    return change === 'up'
      ? $localize`:@@training.body.map.figure.up:cresceu`
      : change === 'down'
        ? $localize`:@@training.body.map.figure.down:diminuiu`
        : change === 'same'
          ? $localize`:@@training.body.map.figure.same:igual`
          : $localize`:@@training.body.map.figure.neutral:sem comparação`;
  }
}
