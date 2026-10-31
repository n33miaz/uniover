import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import type { GoalWriteResult } from '../data/goals/goal-repository';
import { GoalRepository } from '../data/goals/goal-repository';
import type { EnergyState } from './body-store';
import { formatKcalNumber, parseDecimal } from './body-text';
import { MealRepository } from '../data/meals/meal-repository';
import { RouterLink } from '@angular/router';
import { BodyMealsSkeleton } from './body-skeleton';

@Component({
  selector: 'app-body-energy-panel',
  imports: [RouterLink, BodyMealsSkeleton],
  template: `
    <section class="energy" aria-labelledby="energy-title">
      <h2 id="energy-title" i18n="@@training.body.energy.title">Meta de Calorias</h2>
      <section class="consumption" aria-labelledby="consumption-title">
        <div class="consumption-head">
          <h3 id="consumption-title" i18n="@@training.body.energy.consumed-title">
            Consumo de Hoje
          </h3>
          <a routerLink="/treino/alimentacao" i18n="@@training.body.energy.diary-link"
            >Abrir Diário</a
          >
        </div>
        @if (mealsLoaded()) {
          <p class="consumed">
            <strong>{{ formatKcalNumber(consumed().kcal) }}</strong>
            <span i18n="@@training.body.energy.kcal">kcal</span>
          </p>
          @if (readyState(); as ready) {
            <p class="muted" i18n="@@training.body.energy.of-target">
              Meta escolhida: {{ formatKcalNumber(ready.target) }} kcal
            </p>
            <p class="difference" [class.over]="consumed().kcal > ready.target">
              @if (consumed().kcal <= ready.target) {
                <ng-container i18n="@@training.body.energy.remaining"
                  >{{ formatKcalNumber(ready.target - consumed().kcal) }} kcal até a meta
                  escolhida</ng-container
                >
              } @else {
                <ng-container i18n="@@training.body.energy.over"
                  >{{ formatKcalNumber(consumed().kcal - ready.target) }} kcal acima da meta
                  escolhida</ng-container
                >
              }
            </p>
          } @else {
            <p class="muted" i18n="@@training.body.energy.no-target">
              Defina uma meta diária para comparar os valores.
            </p>
          }
          <dl class="macros" aria-label="{{ macrosLabel }}">
            <div>
              <dt i18n="@@training.body.energy.protein">Proteína</dt>
              <dd i18n="@@training.body.energy.protein-value">
                {{ formatKcalNumber(consumed().protein) }} g
              </dd>
            </div>
            <div>
              <dt i18n="@@training.body.energy.carbs">Carboidratos</dt>
              <dd i18n="@@training.body.energy.carbs-value">
                {{ formatKcalNumber(consumed().carbs) }} g
              </dd>
            </div>
            <div>
              <dt i18n="@@training.body.energy.fat">Gorduras</dt>
              <dd i18n="@@training.body.energy.fat-value">
                {{ formatKcalNumber(consumed().fat) }} g
              </dd>
            </div>
          </dl>
        } @else if (mealsError()) {
          <p class="error" role="alert">{{ mealsError() }}</p>
        } @else {
          <app-body-meals-skeleton />
        }
        <p class="muted" i18n="@@training.body.energy.nonprescriptive">
          Valores para acompanhamento pessoal; não são orientação médica.
        </p>
      </section>
      @switch (state().kind) {
        @case ('no-profile') {
          <p class="muted" i18n="@@training.body.energy.no-profile">
            Preencha seu perfil para estimar a taxa basal e o gasto diário.
          </p>
          <button
            class="secondary ui-btn"
            type="button"
            (click)="editProfile.emit()"
            i18n="@@training.body.profile.complete"
          >
            Preencher Perfil
          </button>
        }
        @case ('minor') {
          <p class="muted" role="status" i18n="@@training.body.energy.minor">
            As estimativas de calorias ficam indisponíveis para menores de 18 anos.
          </p>
        }
        @case ('no-weight') {
          <p class="muted" i18n="@@training.body.energy.no-weight">
            Registre um peso para calcular a taxa basal estimada.
          </p>
        }
        @case ('ready') {
          @if (readyState(); as ready) {
            <p class="target">
              <strong>{{ formatKcalNumber(ready.target) }}</strong>
              <span i18n="@@training.body.energy.kcal">kcal</span>
            </p>
            <p class="muted" i18n="@@training.body.energy.goal-caption">
              Meta diária escolhida · estimativa, não uma recomendação
            </p>
            @if (ready.clamped) {
              <p class="warning" role="status">{{ belowText(ready.bmr) }}</p>
            }
            <details>
              <summary i18n="@@training.body.energy.calculation">Como a Meta Foi Calculada</summary>
              <dl>
                <div>
                  <dt i18n="@@training.body.energy.bmr">Taxa Basal Estimada</dt>
                  <dd i18n="@@training.body.energy.kcal-value">
                    {{ formatKcalNumber(ready.bmr) }} kcal
                  </dd>
                </div>
                <div>
                  <dt i18n="@@training.body.energy.factor">Fator de Atividade</dt>
                  <dd>{{ ready.factor }}</dd>
                </div>
                <div>
                  <dt i18n="@@training.body.energy.expenditure">Gasto Diário Estimado</dt>
                  <dd i18n="@@training.body.energy.kcal-value">
                    {{ formatKcalNumber(ready.expenditure) }} kcal
                  </dd>
                </div>
                <p class="muted" i18n="@@training.body.energy.factor-note">
                  Fatores de atividade são uma convenção e podem errar para quem treina.
                </p>
              </dl>
              <button
                class="secondary ui-btn"
                type="button"
                (click)="editProfile.emit()"
                i18n="@@training.body.energy.edit-factor"
              >
                Editar Fator
              </button>
            </details>
            @if (editing()) {
              <div class="ui-field">
                <label for="body-daily-goal" i18n="@@training.body.energy.edit-label"
                  >Sua Meta Diária (kcal)</label
                >
                <input
                  id="body-daily-goal"
                  class="ui-input"
                  inputmode="numeric"
                  i18n-inputmode="@@common.input.numeric"
                  [value]="draft()"
                  (input)="draft.set($any($event.target).value)"
                />
                <p class="muted" i18n="@@training.body.energy.goal-floor">
                  A meta nunca fica abaixo da taxa basal estimada ({{ formatKcalNumber(ready.bmr) }}
                  kcal).
                </p>
              </div>
              @if (error(); as message) {
                <p class="error" role="alert">{{ message }}</p>
              }
              <div class="actions">
                <button
                  class="primary ui-btn"
                  type="button"
                  (click)="save(ready)"
                  i18n="@@training.body.energy.save"
                >
                  Salvar Meta
                </button>
                <button
                  class="secondary ui-btn"
                  type="button"
                  (click)="editing.set(false)"
                  i18n="@@training.body.energy.cancel"
                >
                  Cancelar
                </button>
              </div>
            } @else {
              <button
                class="primary ui-btn"
                type="button"
                (click)="begin(ready)"
                i18n="@@training.body.energy.choose"
              >
                Escolher Meta
              </button>
            }
          }
        }
      }
    </section>
  `,
  styleUrl: './energy-panel.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BodyEnergyPanel {
  private readonly goals = inject(GoalRepository);
  private readonly meals = inject(MealRepository);
  protected readonly mealsLoaded = signal(false);
  protected readonly mealsError = signal('');
  protected readonly consumed = signal({ kcal: 0, protein: 0, carbs: 0, fat: 0 });
  protected readonly macrosLabel = $localize`:@@training.body.energy.macros:Macronutrientes consumidos hoje`;
  readonly state = input.required<EnergyState>();
  protected readonly readyState = computed(() => {
    const current = this.state();
    return current.kind === 'ready' ? current : null;
  });
  readonly editProfile = output<void>();
  protected readonly editing = signal(false);
  protected readonly draft = signal('');
  protected readonly error = signal('');
  private mealLoad = 0;
  protected formatKcalNumber = formatKcalNumber;
  protected belowText = (bmr: number) =>
    $localize`:@@training.body.energy.below:A meta nunca fica abaixo da taxa basal estimada (${formatKcalNumber(bmr)}:bmr: kcal). Escolha pelo menos esse valor.`;

  protected begin(state: Extract<EnergyState, { kind: 'ready' }>): void {
    this.draft.set(String(state.chosen ?? state.target));
    this.error.set('');
    this.editing.set(true);
  }
  constructor() {
    effect(() => {
      this.meals.revision();
      const day = this.meals.today();
      const request = ++this.mealLoad;
      this.mealsLoaded.set(false);
      this.mealsError.set('');
      void this.meals
        .entriesOf(day)
        .then((entries) => {
          if (request !== this.mealLoad) return;
          this.consumed.set(
            entries.reduce(
              (total, entry) => ({
                kcal: total.kcal + entry.kcal,
                protein: total.protein + entry.proteinG,
                carbs: total.carbs + entry.carbG,
                fat: total.fat + entry.fatG,
              }),
              { kcal: 0, protein: 0, carbs: 0, fat: 0 },
            ),
          );
          this.mealsLoaded.set(true);
        })
        .catch(() => {
          if (request !== this.mealLoad) return;
          this.consumed.set({ kcal: 0, protein: 0, carbs: 0, fat: 0 });
          this.mealsError.set(
            $localize`:@@training.body.energy.meals-failed:Não foi possível ler seus lançamentos agora.`,
          );
        });
    });
  }
  protected async save(state: Extract<EnergyState, { kind: 'ready' }>): Promise<void> {
    const value = parseDecimal(this.draft());
    if (value === null || !Number.isInteger(value) || value < state.bmr) {
      this.error.set(this.belowText(state.bmr));
      return;
    }
    const result: GoalWriteResult = await this.goals.set('daily_kcal', value);
    if (result.status === 'saved') {
      this.editing.set(false);
      return;
    }
    this.error.set(
      result.status === 'storage-full'
        ? $localize`:@@training.body.energy.storage:Sem espaço no aparelho para guardar a meta. Libere espaço e tente de novo.`
        : $localize`:@@training.body.energy.invalid:Confira a meta e tente de novo.`,
    );
  }
}
