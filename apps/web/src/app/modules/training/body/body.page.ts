import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { ProgressLineChart } from '../progress/charts/line-chart';
import { BodyMeasurementsSheet } from './measurements-sheet';
import { BodyProfileSheet } from './profile-sheet';
import { BodySection } from './body-section';
import { BodyStore } from './body-store';
import {
  formatCm,
  formatFullDate,
  formatMm,
  formatPercent,
  formatWeight,
  signedWeight,
} from './body-text';
import { BodyEnergyPanel } from './energy-panel';
import { HealthNotice } from './notice/health-notice';
import { BodyNoticeStore } from './notice/notice-store';
import { BodyPhotoPanel } from './photo-panel';
import { BodyMapPanel } from './body-map-panel';
import { BodyRegionHistorySheet } from './region-history-sheet';
import type { BodyMapRegion } from '../domain/body/body-map-signals';
import { WEIGHT_CHART_PROVIDER } from './weight/weight-chart-engine';
import { type WeightPeriod, buildWeightChart, rowsInPeriod } from './weight/weight-model';
import { WeightSheet } from './weight/weight-sheet';
import { BodySkeleton } from './body-skeleton';

type BodyView = 'summary' | 'records' | 'photos';

@Component({
  selector: 'app-training-body-page',
  imports: [
    RouterLink,
    BodySection,
    WeightSheet,
    BodyProfileSheet,
    BodyMeasurementsSheet,
    ProgressLineChart,
    HealthNotice,
    BodyEnergyPanel,
    BodyPhotoPanel,
    BodyMapPanel,
    BodyRegionHistorySheet,
    BodySkeleton,
  ],
  template: `
    <div class="page" aria-labelledby="body-title">
      <header class="intro"><h1 id="body-title" i18n="@@training.body.title">Corpo</h1></header>
      <div class="tabs" role="group" [attr.aria-label]="viewLabel">
        <span class="tab-indicator" aria-hidden="true"></span>
        <button
          type="button"
          [attr.aria-pressed]="view() === 'summary'"
          (click)="selectView('summary')"
          i18n="@@training.body.tab.summary"
        >
          Resumo
        </button>
        <button
          type="button"
          [attr.aria-pressed]="view() === 'records'"
          (click)="selectView('records')"
          i18n="@@training.body.tab.records"
        >
          Registros
        </button>
        <button
          type="button"
          [attr.aria-pressed]="view() === 'photos'"
          (click)="selectView('photos')"
          i18n="@@training.body.tab.photos"
        >
          Fotos
        </button>
      </div>
      <div
        class="section-content"
        [class.forward]="viewDirection() === 'forward'"
        [class.backward]="viewDirection() === 'backward'"
        (animationend)="clearViewDirection($event)"
      >
        @if (!store.ready() && view() !== 'photos') {
          <app-body-skeleton [view]="view() === 'summary' ? 'summary' : 'records'" />
        } @else if (view() === 'summary') {
          <section class="weight-card ui-card" aria-labelledby="weight-panel-title">
            <div class="card-heading">
              <h2 id="weight-panel-title" class="eyebrow" i18n="@@training.body.weight.title">
                Peso
              </h2>
              @if (store.weight(); as weight) {
                <p class="weight-value">{{ formatWeight(weight.latest.weightKg) }}</p>
              }
            </div>
            @if (store.weight(); as weight) {
              <div class="weight-meta">
                <span>{{ weight.isToday ? todayLabel : lastLabel(weight.latest.date) }}</span>
                @if (weight.delta; as delta) {
                  <strong i18n="@@training.body.weight.delta"
                    >{{ signedWeight(delta.deltaKg) }} · {{ delta.spanDays }} dias</strong
                  >
                }
              </div>
              @if (chart(); as spec) {
                <app-progress-line-chart
                  [spec]="spec"
                  (picked)="selected.set($event)"
                  (failed)="chartFailed.set(true)"
                />
                @if (chartFailed()) {
                  <p class="muted" i18n="@@training.body.chart-fallback">
                    O gráfico não pôde ser exibido. Seus registros continuam disponíveis em
                    Registros.
                  </p>
                }
                <p class="chart-caption" i18n="@@training.body.chart.caption">
                  Pontos: pesagens · linha: tendência
                </p>
                <details class="chart-table">
                  <summary i18n="@@training.body.chart.table">Ver Dados do Período</summary>
                  @for (row of chartRows(); track row.id) {
                    <button
                      type="button"
                      class="entry"
                      (click)="editing.set(row.id)"
                      [attr.aria-label]="editLabel(row.date, row.weightKg)"
                    >
                      <span>{{ formatDate(row.date) }}</span
                      ><strong>{{ formatWeight(row.weightKg) }}</strong
                      ><span>{{ formatWeight(row.trendKg) }}</span>
                    </button>
                  }
                </details>
                @if (selectedPoint(); as point) {
                  <p class="chart-detail" aria-live="polite" i18n-aria-live="@@common.aria.polite">
                    {{ chartPointText(point.date, point.weightKg, point.trendKg) }}
                  </p>
                }
              }
            } @else {
              <p class="muted" i18n="@@training.body.weight.empty">Registre seu primeiro peso.</p>
            }
          </section>

          <div class="signal-grid" aria-label="{{ signalsLabel }}">
            <button type="button" class="signal-card" (click)="measureSheetOpen.set(true)">
              <span class="eyebrow" i18n="@@training.body.summary.measurements">Medidas</span>
              @if (primaryMeasure(); as measure) {
                <strong>{{ measure.value }}</strong
                ><small i18n="@@training.body.summary.measure-date"
                  >{{ measure.label }} · {{ formatDate(measure.date) }}</small
                >
              } @else {
                <strong class="none" i18n="@@training.body.summary.none">Sem Registros</strong
                ><small i18n="@@training.body.summary.measurements-help">Registrar Medidas</small>
              }
            </button>
            <button type="button" class="signal-card" (click)="measureSheetOpen.set(true)">
              <span class="eyebrow" i18n="@@training.body.summary.fat">Gordura Corporal</span>
              @if (store.latest().bodyFatPct; as fat) {
                <strong>{{ formatPercent(fat.value) }}</strong
                ><small>{{ fatMethodLabel(fat.fatMethod) }}</small>
              } @else {
                <strong class="none" i18n="@@training.body.summary.none">Sem Registros</strong
                ><small i18n="@@training.body.summary.fat-help">Registrar Percentual</small>
              }
            </button>
          </div>

          <app-body-map-panel [entries]="store.entries()" (history)="historyRegion.set($event)" />

          <section class="signal-links" [attr.aria-label]="shortcutsLabel">
            <a class="signal-row" routerLink="/treino/corpo/avaliacoes"
              ><span i18n="@@training.body.summary.assessments">Avaliações Físicas</span
              ><small i18n="@@training.body.summary.assessments-action">Ver Histórico</small></a
            >
            <button type="button" class="signal-row" (click)="selectView('photos')">
              <span i18n="@@training.body.summary.photos">Fotos de Progresso</span
              ><small i18n="@@training.body.summary.photos-action">Ver Fotos</small>
            </button>
          </section>
          <button type="button" class="primary ui-btn primary-action" (click)="editing.set('new')">
            <span i18n="@@training.body.weight.add">Registrar Peso</span>
          </button>
        } @else if (view() === 'records') {
          <app-body-section
            [heading]="weightHeading"
            [glyph]="'scale'"
            [summary]="weightSummary()"
            [open]="true"
          >
            @if (store.weight(); as weight) {
              <div class="latest">
                <div class="stat">
                  <span class="eyebrow" i18n="@@training.body.weight.last-title"
                    >Última Pesagem</span
                  ><strong>{{
                    weight.isToday ? todayLabel : formatDate(weight.latest.date)
                  }}</strong>
                </div>
                @if (weight.delta; as delta) {
                  <div class="stat delta">
                    <span class="eyebrow" i18n="@@training.body.trend">Tendência</span
                    ><strong i18n="@@training.body.weight.delta"
                      >{{ signedWeight(delta.deltaKg) }} · {{ delta.spanDays }} dias</strong
                    >
                  </div>
                }
              </div>
              <div class="periods" role="group" [attr.aria-label]="periodLabel">
                @for (option of periods; track option.value) {
                  <button
                    type="button"
                    [attr.aria-pressed]="period() === option.value"
                    (click)="period.set(option.value)"
                  >
                    {{ option.label }}
                  </button>
                }
              </div>
              <div class="entries" [attr.aria-label]="historyLabel">
                @for (row of visibleRows(); track row.id) {
                  <button
                    type="button"
                    class="entry"
                    (click)="editing.set(row.id)"
                    [attr.aria-label]="editLabel(row.date, row.weightKg)"
                  >
                    <span>{{ formatDate(row.date) }}</span
                    ><strong>{{ formatWeight(row.weightKg) }}</strong>
                  </button>
                }
              </div>
            } @else {
              <p class="muted" i18n="@@training.body.weight.empty">Registre seu primeiro peso.</p>
            }
            <button type="button" class="primary ui-btn block" (click)="editing.set('new')">
              <span i18n="@@training.body.weight.add">Registrar Peso</span>
            </button>
          </app-body-section>

          <app-body-section
            [heading]="profileHeading"
            [glyph]="'user'"
            [summary]="profileSummary()"
            [open]="store.profile() === null"
          >
            @if (store.profile(); as profile) {
              <p class="profile-line" i18n="@@training.body.profile.summary">
                {{ profile.heightCm }} cm · {{ formatDate(profile.birthDate) }}
              </p>
              @if (store.age() !== null && store.age()! < 18) {
                <p class="notice" role="status" i18n="@@training.body.minor">
                  Os cálculos de saúde ficam indisponíveis para menores de 18 anos.
                </p>
              }
            } @else {
              <p class="muted" i18n="@@training.body.profile.missing">
                Preencha seu perfil para liberar as estimativas.
              </p>
            }
            <button
              type="button"
              class="secondary ui-btn block"
              (click)="profileSheetOpen.set(true)"
            >
              <span>{{ store.profile() ? editProfileLabel : addProfileLabel }}</span>
            </button>
          </app-body-section>

          <app-body-section
            [heading]="measuresHeading"
            [glyph]="'ruler'"
            [summary]="measuresSummary()"
            [open]="false"
          >
            <div class="measure-list">
              @for (measure of measures(); track measure.key) {
                @if (measure.value !== null) {
                  <div class="measure-row">
                    <span>{{ measure.label }}</span
                    ><strong>{{ measure.value }}</strong
                    ><small>{{ formatDate(measure.date) }}</small>
                  </div>
                }
              }
            </div>
            @if (store.latest().bodyFatPct; as fat) {
              <p class="fat-value">
                <strong>{{ formatPercent(fat.value) }}</strong
                ><span>{{ fatMethodLabel(fat.fatMethod) }} · {{ formatDate(fat.measuredOn) }}</span>
              </p>
            } @else {
              <p class="muted" i18n="@@training.body.measure.empty-card">
                Ainda não há percentual de gordura registrado.
              </p>
            }
            <button type="button" class="primary ui-btn block" (click)="measureSheetOpen.set(true)">
              <span i18n="@@training.body.measure.add">Registrar Medidas</span>
            </button>
          </app-body-section>
          <app-body-energy-panel
            [state]="store.energy()"
            (editProfile)="profileSheetOpen.set(true)"
          />
        } @else {
          <app-body-photo-panel />
        }
      </div>
      <app-body-health-notice />
      @if (editing(); as target) {
        <app-weight-sheet
          [today]="store.today()"
          [entry]="target === 'new' ? null : entry(target)"
          (closed)="editing.set(null)"
        />
      }
      @if (profileSheetOpen()) {
        <app-body-profile-sheet
          [profile]="store.profile()"
          [today]="store.today()"
          (closed)="profileSheetOpen.set(false)"
        />
      }
      @if (historyRegion(); as region) {
        <app-body-region-history-sheet
          [region]="region"
          [entries]="store.entries()"
          (register)="registerFromHistory()"
          (closed)="historyRegion.set(null)"
        />
      }
      @if (measureSheetOpen()) {
        <app-body-measurements-sheet
          [profile]="store.profile()"
          [age]="store.age()"
          [today]="store.today()"
          (closed)="measureSheetOpen.set(false)"
        />
      }
    </div>
  `,
  styles: `
    :host {
      display: block;
    }
    .page,
    .section-content {
      display: flex;
      flex-direction: column;
      gap: var(--space-3);
      min-width: 0;
    }
    .page {
      padding: 0 var(--space-4) var(--space-5);
    }
    .intro h1,
    h2,
    p {
      margin: 0;
    }
    .intro h1 {
      font-size: var(--fs-title, 1.5rem);
    }
    .tabs {
      position: relative;
      isolation: isolate;
      display: flex;
      gap: 3px;
      padding: 3px;
      border-radius: var(--radius-pill, 999px);
      background: var(--a-surface-2);
    }
    .tab-indicator {
      position: absolute;
      z-index: -1;
      inset-block: 3px;
      left: 3px;
      width: calc((100% - 12px) / 3);
      border-radius: inherit;
      background: var(--a-surface);
      box-shadow: 0 1px 4px #0002;
      transition: transform 220ms var(--ease-out);
    }
    .tabs:has(button:nth-of-type(2)[aria-pressed='true']) .tab-indicator {
      transform: translateX(calc(100% + 3px));
    }
    .tabs:has(button:nth-of-type(3)[aria-pressed='true']) .tab-indicator {
      transform: translateX(calc(200% + 6px));
    }
    .tabs button,
    .periods button {
      flex: 1;
      min-height: 40px;
      border: 0;
      border-radius: inherit;
      color: var(--a-ink2);
      background: transparent;
      font: inherit;
      font-size: var(--fs-small);
    }
    .tabs button[aria-pressed='true'],
    .periods button[aria-pressed='true'] {
      color: var(--a-ink);
      background: var(--a-surface);
      box-shadow: 0 1px 4px #0002;
    }
    .tabs button:focus-visible {
      outline-offset: -3px;
    }
    .section-content.forward {
      animation: section-enter-forward 200ms var(--ease-out) both;
    }
    .section-content.backward {
      animation: section-enter-backward 200ms var(--ease-out) both;
    }
    @keyframes section-enter-forward {
      from {
        opacity: 0.65;
        transform: translateX(18px);
      }
      to {
        opacity: 1;
        transform: translateX(0);
      }
    }
    @keyframes section-enter-backward {
      from {
        opacity: 0.65;
        transform: translateX(-18px);
      }
      to {
        opacity: 1;
        transform: translateX(0);
      }
    }
    .weight-card {
      display: grid;
      gap: var(--space-3);
      padding: var(--space-3);
    }
    .card-heading,
    .latest,
    .weight-meta,
    .fat-value {
      display: flex;
      justify-content: space-between;
      align-items: end;
      gap: var(--space-3);
    }
    h2 {
      font-size: clamp(1.1rem, 4.8vw, 1.25rem);
    }
    .eyebrow,
    .muted,
    .weight-meta,
    .chart-caption,
    .chart-detail,
    .profile-line,
    .measure-row small,
    .fat-value span {
      color: var(--a-ink2);
      font-size: var(--fs-small);
    }
    .weight-value,
    .value {
      margin: 0;
      font-size: clamp(2rem, 10vw, 2.75rem);
      font-weight: 750;
      letter-spacing: -0.04em;
      font-variant-numeric: tabular-nums;
    }
    .weight-meta {
      align-items: center;
    }
    .weight-meta strong,
    .stat strong {
      color: var(--a-ink);
      font-variant-numeric: tabular-nums;
    }
    .chart-caption,
    .chart-detail {
      text-align: center;
    }
    .chart-table summary {
      display: flex;
      min-height: var(--tap);
      align-items: center;
      cursor: pointer;
    }
    .signal-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: var(--space-2);
    }
    .signal-card {
      display: grid;
      min-width: 0;
      min-height: 104px;
      align-content: start;
      gap: 5px;
      padding: var(--space-3);
      border: 0;
      border-radius: var(--radius-sm);
      color: var(--a-ink);
      background: var(--a-surface-2);
      text-align: left;
      font: inherit;
    }
    .signal-card strong {
      overflow: hidden;
      font-size: clamp(1.25rem, 6vw, 1.5rem);
      letter-spacing: -0.03em;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .signal-card strong.none {
      font-size: var(--fs-body);
      font-weight: 600;
      letter-spacing: 0;
      color: var(--a-ink2);
    }
    .signal-card small {
      color: var(--a-ink2);
      font-size: var(--fs-small);
    }
    .signal-row {
      display: flex;
      width: 100%;
      min-height: var(--tap);
      align-items: center;
      justify-content: space-between;
      gap: var(--space-2);
      padding: 0;
      border: 0;
      border-top: 1px solid var(--a-line);
      color: var(--a-ink);
      background: transparent;
      text-align: left;
      text-decoration: none;
      font: inherit;
    }
    .signal-row:last-child {
      border-bottom: 1px solid var(--a-line);
    }
    .signal-row small {
      color: var(--a-ink2);
      font-size: var(--fs-small);
    }
    .primary-action,
    .block {
      display: flex;
      width: 100%;
      align-items: center;
      justify-content: center;
    }
    .primary-action {
      min-height: var(--tap);
    }
    .periods {
      display: flex;
      gap: 3px;
      padding: 3px;
      border-radius: var(--radius-pill, 999px);
      background: var(--a-surface-2);
    }
    .periods button {
      min-height: 36px;
    }
    .latest {
      align-items: start;
    }
    .stat {
      display: grid;
      gap: 3px;
      min-width: 0;
    }
    .stat strong {
      font-variant-numeric: tabular-nums;
      white-space: nowrap;
    }
    .stat.delta {
      text-align: right;
    }
    .entries {
      display: grid;
      gap: 1px;
      border-top: 1px solid var(--a-line);
    }
    .entry {
      display: flex;
      min-height: var(--tap);
      align-items: center;
      justify-content: space-between;
      padding: 0 var(--space-2);
      border: 0;
      border-bottom: 1px solid var(--a-line);
      color: inherit;
      background: transparent;
      text-align: left;
      font: inherit;
    }
    .entry strong {
      font-variant-numeric: tabular-nums;
    }
    .notice {
      padding: var(--space-2);
      border-radius: var(--radius-sm);
      background: var(--a-surface-2);
      font-size: var(--fs-small);
    }
    .measure-list {
      display: grid;
      gap: 1px;
    }
    .measure-row {
      display: grid;
      grid-template-columns: 1fr auto auto;
      gap: var(--space-2);
      align-items: center;
      min-height: 44px;
      border-bottom: 1px solid var(--a-line);
    }
    @media (prefers-reduced-motion: reduce) {
      .tab-indicator {
        transition: none;
      }
      .section-content.forward,
      .section-content.backward {
        animation: none;
      }
    }
  `,
  providers: [BodyStore, BodyNoticeStore, WEIGHT_CHART_PROVIDER],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BodyPage {
  protected readonly store = inject(BodyStore);
  protected readonly view = signal<BodyView>('summary');
  protected readonly viewDirection = signal<'forward' | 'backward' | null>(null);
  protected readonly period = signal<WeightPeriod>('6m');
  protected readonly selected = signal<number | null>(null);
  protected readonly chartFailed = signal(false);
  protected readonly editing = signal<string | null>(null);
  protected readonly profileSheetOpen = signal(false);
  protected readonly measureSheetOpen = signal(false);
  /** A região do mapa cujo histórico está aberto (a folha de leitura). */
  protected readonly historyRegion = signal<BodyMapRegion | null>(null);
  protected readonly viewLabel = $localize`:@@training.body.tabs:Seções do corpo`;
  protected readonly signalsLabel = $localize`:@@training.body.summary.signals:Sinais do corpo`;
  protected readonly shortcutsLabel = $localize`:@@training.body.summary.shortcuts:Mais informações do corpo`;
  protected readonly weightHeading = $localize`:@@training.body.weight.title:Peso`;
  protected readonly profileHeading = $localize`:@@training.body.profile.title:Perfil`;
  protected readonly measuresHeading = $localize`:@@training.body.measure.title:Medidas e Gordura Corporal`;
  protected readonly todayLabel = $localize`:@@training.body.weight.today:Hoje`;
  protected readonly periodLabel = $localize`:@@training.body.period.label:Período do gráfico`;
  protected readonly historyLabel = $localize`:@@training.body.weight.history:Pesagens recentes`;
  protected readonly editProfileLabel = $localize`:@@training.body.profile.edit:Editar Perfil`;
  protected readonly addProfileLabel = $localize`:@@training.body.profile.complete:Preencher Perfil`;
  private readonly measureRows = [
    { key: 'waistCm', label: $localize`:@@training.body.measure.waist-short:Cintura` },
    { key: 'chestCm', label: $localize`:@@training.body.measure.chest-short:Tórax` },
    { key: 'abdomenCm', label: $localize`:@@training.body.measure.abdomen-short:Abdômen` },
    { key: 'neckCm', label: $localize`:@@training.body.measure.neck-short:Pescoço` },
    { key: 'hipCm', label: $localize`:@@training.body.measure.hip-short:Quadril` },
    { key: 'armCm', label: $localize`:@@training.body.measure.arm-short:Braço` },
    { key: 'armRightCm', label: $localize`:@@training.body.measure.arm-right-short:Braço D` },
    { key: 'armLeftCm', label: $localize`:@@training.body.measure.arm-left-short:Braço E` },
    {
      key: 'forearmRightCm',
      label: $localize`:@@training.body.measure.forearm-right-short:Antebraço D`,
    },
    {
      key: 'forearmLeftCm',
      label: $localize`:@@training.body.measure.forearm-left-short:Antebraço E`,
    },
    { key: 'thighCm', label: $localize`:@@training.body.measure.thigh-short:Coxa` },
    { key: 'thighRightCm', label: $localize`:@@training.body.measure.thigh-right-short:Coxa D` },
    { key: 'thighLeftCm', label: $localize`:@@training.body.measure.thigh-left-short:Coxa E` },
    {
      key: 'calfRightCm',
      label: $localize`:@@training.body.measure.calf-right-short:Panturrilha D`,
    },
    { key: 'calfLeftCm', label: $localize`:@@training.body.measure.calf-left-short:Panturrilha E` },
    {
      key: 'chestSkinfoldMm',
      label: $localize`:@@training.body.measure.chest-skinfold-short:Dobra Peitoral`,
    },
    {
      key: 'abdomenSkinfoldMm',
      label: $localize`:@@training.body.measure.abdomen-skinfold-short:Dobra Abdominal`,
    },
    {
      key: 'thighSkinfoldMm',
      label: $localize`:@@training.body.measure.thigh-skinfold-short:Dobra da Coxa`,
    },
  ] as const;
  protected readonly periods = [
    { value: '30d' as const, label: $localize`:@@training.body.period.30d:30 dias` },
    { value: '6m' as const, label: $localize`:@@training.body.period.6m:6 meses` },
    { value: 'all' as const, label: $localize`:@@training.body.period.all:Tudo` },
  ];
  protected readonly chartRows = computed(() =>
    rowsInPeriod(this.store.rows(), this.period(), this.store.today()),
  );
  protected readonly selectedIndex = computed(() =>
    this.selected() !== null && this.selected()! < this.chartRows().length ? this.selected() : null,
  );
  protected readonly selectedPoint = computed(() => {
    const index = this.selectedIndex();
    return index === null ? null : (this.chartRows()[index] ?? null);
  });
  protected readonly chart = computed(() => {
    const rows = this.chartRows();
    return rows.length
      ? buildWeightChart({
          rows,
          period: this.period(),
          today: this.store.today(),
          selected: this.selectedIndex(),
        })
      : null;
  });
  protected readonly visibleRows = computed(() => [...this.store.rows()].reverse().slice(0, 5));
  protected readonly weightSummary = computed(() => {
    const weight = this.store.weight();
    return weight ? formatWeight(weight.latest.weightKg) : '';
  });
  protected readonly profileSummary = computed(() => {
    const profile = this.store.profile();
    return profile
      ? `${profile.heightCm} cm · ${this.store.age() ?? ''} anos`
      : $localize`:@@training.body.profile.missing-summary:Preencha seu perfil`;
  });
  /** Última medida de cada campo, na ordem da folha de registro; o que nunca foi medido não aparece. */
  protected readonly measures = computed(() => {
    const latest = this.store.latest();
    return this.measureRows.map(({ key, label }) => {
      const found = latest[key];
      return {
        key,
        label,
        value: found
          ? key.endsWith('SkinfoldMm')
            ? formatMm(found.value)
            : formatCm(found.value)
          : null,
        date: found?.measuredOn ?? '',
      };
    });
  });
  /**
   * A medida que o cartão de Medidas mostra: a cintura quando há, senão a primeira que o dono já registrou (tórax, braços...).
   * Quem só mede o tórax não vê "Sem Registros" com medidas guardadas.
   */
  protected readonly primaryMeasure = computed(
    () => this.measures().find((measure) => measure.value !== null) ?? null,
  );
  protected readonly measuresSummary = computed(() => {
    const fat = this.store.latest().bodyFatPct;
    return fat ? formatPercent(fat.value) : '';
  });
  protected readonly formatWeight = formatWeight;
  protected readonly formatPercent = formatPercent;
  protected readonly formatCm = formatCm;
  protected readonly formatDate = formatFullDate;
  protected readonly signedWeight = signedWeight;

  protected selectView(next: BodyView): void {
    const order = { summary: 0, records: 1, photos: 2 } as const;
    const current = this.view();
    if (current === next) return;
    this.viewDirection.set(
      globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches
        ? null
        : order[next] > order[current]
          ? 'forward'
          : 'backward',
    );
    this.view.set(next);
  }
  /** Do histórico direto para o registro: uma folha sai e a outra entra, sem duas modais abertas juntas. */
  protected registerFromHistory(): void {
    this.historyRegion.set(null);
    this.measureSheetOpen.set(true);
  }
  protected clearViewDirection(event: AnimationEvent): void {
    if (event.target === event.currentTarget) this.viewDirection.set(null);
  }
  protected fatMethodLabel(method: string | null): string {
    return method === 'navy'
      ? $localize`:@@training.body.fat.method.navy:Marinha`
      : method === 'bioimpedance'
        ? $localize`:@@training.body.fat.method.bioimpedance:Bioimpedância`
        : $localize`:@@training.body.fat.method.manual:Informado por você`;
  }
  protected lastLabel(date: string): string {
    return $localize`:@@training.body.weight.last:Última Pesagem · ${formatFullDate(date)}:date:`;
  }
  protected editLabel(date: string, kg: number): string {
    return $localize`:@@training.body.weight.edit:Editar pesagem de ${formatFullDate(date)}:date:, ${formatWeight(kg)}:weight:`;
  }
  protected chartPointText(date: string, kg: number, trend: number): string {
    return $localize`:@@training.body.chart.point:${formatFullDate(date)}:date: · pesagem ${formatWeight(kg)}:weight: · tendência ${formatWeight(trend)}:trend:`;
  }
  protected entry(id: string) {
    return this.store.entries().find((item) => item.id === id) ?? null;
  }
}
