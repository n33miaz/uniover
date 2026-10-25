import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { BodyStore } from './body-store';
import { BodySection } from './body-section';
import { BodyGlyph } from './body-glyph';
import { formatCm, formatFullDate, formatPercent, formatWeight, signedWeight } from './body-text';
import { WeightSheet } from './weight/weight-sheet';
import { BodyProfileSheet } from './profile-sheet';
import { BodyMeasurementsSheet } from './measurements-sheet';
import { type WeightPeriod, buildWeightChart, rowsInPeriod } from './weight/weight-model';
import { WEIGHT_CHART_PROVIDER } from './weight/weight-chart-engine';
import { ProgressLineChart } from '../progress/charts/line-chart';
import { HealthNotice } from './notice/health-notice';
import { BodyEnergyPanel } from './energy-panel';
import { BodyPhotoPanel } from './photo-panel';
import { BodyNoticeStore } from './notice/notice-store';

@Component({
  selector: 'app-training-body-page',
  imports: [
    RouterLink,
    BodySection,
    BodyGlyph,
    WeightSheet,
    BodyProfileSheet,
    BodyMeasurementsSheet,
    ProgressLineChart,
    HealthNotice,
    BodyEnergyPanel,
    BodyPhotoPanel,
  ],
  template: `
    <div class="page" aria-labelledby="body-title">
      <header class="intro"><h1 id="body-title" i18n="@@training.body.title">Corpo</h1></header>
      <div class="tabs" role="group" [attr.aria-label]="sectionLabel">
        <span class="tab-indicator" aria-hidden="true"></span>
        <button
          type="button"
          [attr.aria-pressed]="section() === 'weight'"
          (click)="selectSection('weight')"
          i18n="@@training.body.tab.weight"
        >
          Peso
        </button>
        <button
          type="button"
          [attr.aria-pressed]="section() === 'energy'"
          (click)="selectSection('energy')"
          i18n="@@training.body.tab.energy"
        >
          Calorias
        </button>
        <button
          type="button"
          [attr.aria-pressed]="section() === 'photos'"
          (click)="selectSection('photos')"
          i18n="@@training.body.tab.photos"
        >
          Fotos
        </button>
      </div>
      <app-body-health-notice />
      <a
        class="assessment-entry"
        routerLink="/treino/corpo/avaliacoes"
        i18n="@@training.body.assessments-link"
      >
        Histórico de avaliações físicas
      </a>
      <div
        class="section-content"
        [class.forward]="sectionDirection() === 'forward'"
        [class.backward]="sectionDirection() === 'backward'"
        (animationend)="clearSectionDirection($event)"
      >
        @if (section() === 'weight') {
          <app-body-section
            [heading]="weightHeading"
            [glyph]="'scale'"
            [summary]="summary()"
            [open]="true"
          >
            @if (!store.ready()) {
              <p class="muted" i18n="@@training.body.loading">Carregando seus registros…</p>
            } @else if (store.weight(); as weight) {
              <div class="latest">
                <div>
                  <span class="eyebrow">{{
                    weight.isToday ? todayLabel : lastLabel(weight.latest.date)
                  }}</span>
                  <p class="value">{{ formatWeight(weight.latest.weightKg) }}</p>
                  @if (weight.previousIsYesterday && weight.previous; as previous) {
                    <span class="eyebrow" i18n="@@training.body.yesterday"
                      >Ontem · {{ formatWeight(previous.weightKg) }}</span
                    >
                  }
                </div>
                @if (weight.delta; as delta) {
                  <div class="delta">
                    <span i18n="@@training.body.trend">Tendência · {{ delta.spanDays }} dias</span
                    ><strong>{{ signedWeight(delta.deltaKg) }}</strong>
                  </div>
                }
              </div>
              <div class="periods" role="group" [attr.aria-label]="periodLabel">
                <button
                  type="button"
                  [attr.aria-pressed]="period() === '30d'"
                  (click)="period.set('30d')"
                  i18n="@@training.body.period.30d"
                >
                  30 dias
                </button>
                <button
                  type="button"
                  [attr.aria-pressed]="period() === '6m'"
                  (click)="period.set('6m')"
                  i18n="@@training.body.period.6m"
                >
                  6 meses
                </button>
                <button
                  type="button"
                  [attr.aria-pressed]="period() === 'all'"
                  (click)="period.set('all')"
                  i18n="@@training.body.period.all"
                >
                  Tudo
                </button>
              </div>
              @if (chart(); as spec) {
                <app-progress-line-chart
                  [spec]="spec"
                  (picked)="selected.set($event)"
                  (failed)="chartFailed.set(true)"
                />
                @if (chartFailed()) {
                  <p class="muted" i18n="@@training.body.chart-fallback">
                    O gráfico não pôde ser exibido. Seus registros continuam disponíveis abaixo.
                  </p>
                }
                <p class="chart-caption" i18n="@@training.body.chart.caption">
                  Pontos: pesagens · linha: tendência
                </p>
                @if (selectedPoint(); as point) {
                  <p class="chart-detail" [attr.aria-live]="'polite'">
                    {{ chartPointText(point.date, point.weightKg, point.trendKg) }}
                  </p>
                }
                <details class="chart-table">
                  <summary i18n="@@training.body.chart.table">Ver dados do período</summary>
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
              }
              <div class="entries" aria-label="{{ historyLabel }}">
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
              <button type="button" class="primary ui-btn block" (click)="editing.set('new')">
                <app-body-glyph name="scale" /><span i18n="@@training.body.weight.add"
                  >Registrar peso</span
                >
              </button>
            } @else {
              <div class="empty">
                <app-body-glyph name="scale" />
                <p i18n="@@training.body.weight.empty">
                  Registre seu primeiro peso para acompanhar como ele muda ao longo do tempo.
                </p>
                <button
                  type="button"
                  class="primary ui-btn"
                  (click)="editing.set('new')"
                  i18n="@@training.body.weight.add"
                >
                  Registrar peso
                </button>
              </div>
            }
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
                ><span
                  >{{ fatMethodLabel(fat.fatMethod) }} · {{ formatDate(fat.measuredOn) }} ·
                  {{ fat.fatMethod === 'navy' ? estimatedLabel : '' }}</span
                >
              </p>
            } @else {
              <p class="muted" i18n="@@training.body.measure.empty-card">
                Ainda não há percentual de gordura registrado.
              </p>
            }
            <button type="button" class="primary ui-btn block" (click)="measureSheetOpen.set(true)">
              <span i18n="@@training.body.measure.add">Registrar medidas</span>
            </button>
          </app-body-section>
        } @else if (section() === 'energy') {
          <app-body-energy-panel
            [state]="store.energy()"
            (editProfile)="profileSheetOpen.set(true)"
          />
        } @else {
          <app-body-photo-panel />
        }
      </div>
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
    .page {
      display: flex;
      flex-direction: column;
      gap: var(--space-3);
      padding: 0 var(--space-4) calc(var(--space-5) + env(safe-area-inset-bottom));
    }
    .intro h1 {
      margin: 0;
      font-size: var(--fs-title, 1.5rem);
    }
    .assessment-entry {
      display: flex;
      min-height: var(--tap, 44px);
      align-items: center;
      padding: 0 var(--space-3);
      border: 1px solid var(--a-line);
      border-radius: var(--radius-sm);
      color: var(--a-ink);
      background: var(--a-surface);
      text-decoration: none;
      font-weight: 600;
    }
    .tabs {
      position: relative;
      isolation: isolate;
      display: flex;
      padding: 3px;
      gap: 3px;
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
      transform: translateX(0);
    }
    .tabs:has(button:nth-of-type(2)[aria-pressed='true']) .tab-indicator {
      transform: translateX(calc(100% + 3px));
    }
    .tabs:has(button:nth-of-type(3)[aria-pressed='true']) .tab-indicator {
      transform: translateX(calc(200% + 6px));
    }
    .tabs button {
      flex: 1;
      min-height: 40px;
      border: 0;
      border-radius: inherit;
      color: var(--a-ink2);
      background: transparent;
      font: inherit;
      font-size: var(--fs-small);
    }
    .tabs button[aria-pressed='true'] {
      color: var(--a-ink);
    }
    .tabs button:focus-visible {
      outline-offset: -3px;
    }
    .section-content {
      display: flex;
      flex-direction: column;
      gap: var(--space-3);
      min-width: 0;
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
    .latest {
      display: flex;
      justify-content: space-between;
      align-items: end;
      gap: var(--space-3);
    }
    .eyebrow,
    .delta {
      color: var(--a-ink2);
      font-size: var(--fs-small);
    }
    .value {
      margin: 2px 0 0;
      font-size: clamp(2rem, 10vw, 2.75rem);
      font-weight: 750;
      letter-spacing: -0.04em;
    }
    .delta {
      display: grid;
      gap: 3px;
      text-align: right;
    }
    .delta strong {
      color: var(--a-ink);
      font-size: 1.1rem;
    }
    .periods {
      display: flex;
      padding: 3px;
      gap: 3px;
      border-radius: var(--radius-pill, 999px);
      background: var(--a-surface-2);
    }
    .periods button {
      flex: 1;
      min-height: 36px;
      border: 0;
      border-radius: inherit;
      color: var(--a-ink2);
      background: transparent;
      font: inherit;
      font-size: var(--fs-small);
    }
    .periods button[aria-pressed='true'] {
      color: var(--a-ink);
      background: var(--a-surface);
      box-shadow: 0 1px 4px #0002;
    }
    .chart-caption,
    .muted {
      margin: 0;
      color: var(--a-ink2);
      font-size: var(--fs-small);
    }
    .chart-caption {
      text-align: center;
    }
    .chart-detail {
      margin: 0;
      text-align: center;
      font-size: var(--fs-small);
      font-variant-numeric: tabular-nums;
    }
    .chart-table summary {
      min-height: var(--tap);
      display: flex;
      align-items: center;
      cursor: pointer;
    }
    .entries {
      display: grid;
      gap: 1px;
      border-top: 1px solid var(--a-line);
    }
    .entry {
      display: flex;
      justify-content: space-between;
      min-height: var(--tap);
      align-items: center;
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
    .empty {
      display: grid;
      justify-items: center;
      gap: var(--space-3);
      padding: var(--space-5) var(--space-2);
      color: var(--a-ink2);
      text-align: center;
    }
    .empty p {
      max-width: 30ch;
      margin: 0;
    }
    .block {
      display: flex;
      width: 100%;
      align-items: center;
      justify-content: center;
      gap: var(--space-2);
    }
    .profile-line {
      margin: 0;
      color: var(--a-ink2);
    }
    .notice {
      margin: 0;
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
    .measure-row small,
    .fat-value span {
      color: var(--a-ink2);
      font-size: var(--fs-small);
    }
    .fat-value {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      gap: var(--space-2);
      margin: 0;
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
  protected readonly period = signal<WeightPeriod>('6m');
  protected readonly section = signal<'weight' | 'energy' | 'photos'>('weight');
  protected readonly sectionDirection = signal<'forward' | 'backward' | null>(null);
  protected readonly sectionLabel = $localize`:@@training.body.tabs:Seções do corpo`;
  protected readonly selected = signal<number | null>(null);
  protected readonly chartFailed = signal(false);
  protected readonly editing = signal<string | null>(null);
  protected readonly profileSheetOpen = signal(false);
  protected readonly measureSheetOpen = signal(false);
  protected readonly weightHeading = $localize`:@@training.body.weight.title:Peso`;
  protected readonly todayLabel = $localize`:@@training.body.weight.today:Hoje`;
  protected readonly periodLabel = $localize`:@@training.body.period.label:Período do gráfico`;
  protected readonly historyLabel = $localize`:@@training.body.weight.history:Pesagens recentes`;
  protected readonly profileHeading = $localize`:@@training.body.profile.title:Perfil`;
  protected readonly editProfileLabel = $localize`:@@training.body.profile.edit:Editar perfil`;
  protected readonly addProfileLabel = $localize`:@@training.body.profile.complete:Preencher perfil`;
  protected readonly measuresHeading = $localize`:@@training.body.measure.title:Gordura e medidas`;
  protected readonly estimatedLabel = $localize`:@@training.body.fat.estimated:estimado`;
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
  protected readonly summary = computed(() => {
    const weight = this.store.weight();
    return weight ? formatWeight(weight.latest.weightKg) : '';
  });
  protected readonly profileSummary = computed(() => {
    const profile = this.store.profile();
    return profile
      ? `${profile.heightCm} cm · ${this.store.age() ?? ''} anos`
      : $localize`:@@training.body.profile.missing-summary:Preencha seu perfil`;
  });
  protected readonly measures = computed(() => {
    const latest = this.store.latest();
    return [
      {
        key: 'waist',
        label: $localize`:@@training.body.measure.waist-short:Cintura / abdômen`,
        value: latest.waistCm ? formatCm(latest.waistCm.value) : null,
        date: latest.waistCm?.measuredOn ?? '',
      },
      {
        key: 'neck',
        label: $localize`:@@training.body.measure.neck-short:Pescoço`,
        value: latest.neckCm ? formatCm(latest.neckCm.value) : null,
        date: latest.neckCm?.measuredOn ?? '',
      },
      {
        key: 'hip',
        label: $localize`:@@training.body.measure.hip-short:Quadril`,
        value: latest.hipCm ? formatCm(latest.hipCm.value) : null,
        date: latest.hipCm?.measuredOn ?? '',
      },
      {
        key: 'arm',
        label: $localize`:@@training.body.measure.arm-short:Braço`,
        value: latest.armCm ? formatCm(latest.armCm.value) : null,
        date: latest.armCm?.measuredOn ?? '',
      },
      {
        key: 'thigh',
        label: $localize`:@@training.body.measure.thigh-short:Coxa`,
        value: latest.thighCm ? formatCm(latest.thighCm.value) : null,
        date: latest.thighCm?.measuredOn ?? '',
      },
    ];
  });
  protected readonly measuresSummary = computed(() => {
    const latest = this.store.latest();
    return latest.bodyFatPct ? formatPercent(latest.bodyFatPct.value) : '';
  });
  protected readonly formatWeight = formatWeight;

  protected selectSection(next: 'weight' | 'energy' | 'photos'): void {
    const order = { weight: 0, energy: 1, photos: 2 } as const;
    const current = this.section();
    if (current === next) return;
    this.sectionDirection.set(
      globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches
        ? null
        : order[next] > order[current]
          ? 'forward'
          : 'backward',
    );
    this.section.set(next);
  }

  protected clearSectionDirection(event: AnimationEvent): void {
    if (event.target !== event.currentTarget) return;
    this.sectionDirection.set(null);
  }
  protected readonly formatPercent = formatPercent;
  protected readonly signedWeight = signedWeight;
  protected readonly formatDate = formatFullDate;
  protected readonly fatMethodLabel = (method: string | null) =>
    method === 'navy'
      ? $localize`:@@training.body.fat.method.navy:Marinha`
      : method === 'bioimpedance'
        ? $localize`:@@training.body.fat.method.bioimpedance:Bioimpedância`
        : $localize`:@@training.body.fat.method.manual:Informado por você`;
  protected lastLabel(date: string): string {
    return $localize`:@@training.body.weight.last:Última pesagem · ${formatFullDate(date)}:date:`;
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
