import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import type { GoalWriteResult } from '../data/goals/goal-repository';
import { GoalRepository } from '../data/goals/goal-repository';
import type { EnergyState } from './body-store';
import { formatKcalNumber, parseDecimal } from './body-text';

@Component({
  selector: 'app-body-energy-panel',
  template: `
    <section class="energy" aria-labelledby="energy-title">
      <h2 id="energy-title" i18n="@@training.body.energy.title">Meta de calorias</h2>
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
            Preencher perfil
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
              <summary i18n="@@training.body.energy.calculation">Como a meta foi calculada</summary>
              <dl>
                <div>
                  <dt i18n="@@training.body.energy.bmr">Taxa basal estimada</dt>
                  <dd i18n="@@training.body.energy.kcal-value">
                    {{ formatKcalNumber(ready.bmr) }} kcal
                  </dd>
                </div>
                <div>
                  <dt i18n="@@training.body.energy.factor">Fator de atividade</dt>
                  <dd>{{ ready.factor }}</dd>
                </div>
                <div>
                  <dt i18n="@@training.body.energy.expenditure">Gasto diário estimado</dt>
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
                Editar fator
              </button>
            </details>
            @if (editing()) {
              <div class="ui-field">
                <label for="body-daily-goal" i18n="@@training.body.energy.edit-label"
                  >Sua meta diária (kcal)</label
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
                  Salvar meta
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
                Escolher meta
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
  readonly state = input.required<EnergyState>();
  protected readonly readyState = computed(() => {
    const current = this.state();
    return current.kind === 'ready' ? current : null;
  });
  readonly editProfile = output<void>();
  protected readonly editing = signal(false);
  protected readonly draft = signal('');
  protected readonly error = signal('');
  protected formatKcalNumber = formatKcalNumber;
  protected belowText = (bmr: number) =>
    $localize`:@@training.body.energy.below:A meta nunca fica abaixo da taxa basal estimada (${formatKcalNumber(bmr)}:bmr: kcal). Escolha pelo menos esse valor.`;

  protected begin(state: Extract<EnergyState, { kind: 'ready' }>): void {
    this.draft.set(String(state.chosen ?? state.target));
    this.error.set('');
    this.editing.set(true);
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
