import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import type { LocalBodyEntry } from '../data/body/body-entry';
import type { LocalBodyProfile } from '../data/body/body-profile';
import { type LatestMeasurements, BodyRepository } from '../data/body/body-repository';
import { ProfileRepository } from '../data/body/profile-repository';
import { GoalRepository } from '../data/goals/goal-repository';
import { ADULT_AGE_YEARS } from '../domain/body/body-limits';
import { ageYears, calorieTarget, mifflinStJeor, tdee } from '../domain/body/energy';
import { summarizeWeight, weightRows } from './weight/weight-model';

/** O que a conta da meta de calorias já tem; cada pedaço só existe quando o anterior existe. */
export type EnergyState =
  /** Sem perfil: nada a calcular. */
  | { readonly kind: 'no-profile' }
  /** Menor de 18 anos: os cálculos ficam indisponíveis (o registro continua valendo). */
  | { readonly kind: 'minor' }
  /** Perfil pronto, mas nenhuma pesagem: a taxa basal precisa do peso. */
  | { readonly kind: 'no-weight' }
  | {
      readonly kind: 'ready';
      readonly weightKg: number;
      readonly bmr: number;
      readonly factor: number;
      /** Gasto estimado: taxa basal vezes o fator. */
      readonly expenditure: number;
      /** A meta que o dono guardou, ou `null` se ainda não escolheu (vale o gasto estimado). */
      readonly chosen: number | null;
      /** A meta em uso (nunca abaixo da taxa basal). */
      readonly target: number;
      /** A meta escolhida está abaixo da taxa basal de hoje: a conta usa a taxa basal e a tela avisa. */
      readonly clamped: boolean;
    };

/**
 * Os dados da tela Corpo, lidos do banco local (nunca esperam a rede) e refeitos a cada gravação neste aparelho ou
 * a cada leitura do servidor. Fica no injetor da tela: as seções leem o mesmo resultado, e a leitura se faz uma vez.
 * Dado de saúde nunca vai para log: a falha de leitura só deixa a tela no estado vazio.
 */
@Injectable()
export class BodyStore {
  private readonly body = inject(BodyRepository);
  private readonly profiles = inject(ProfileRepository);
  private readonly goals = inject(GoalRepository);

  private readonly _ready = signal(false);
  private readonly _entries = signal<readonly LocalBodyEntry[]>([]);
  private readonly _latest = signal<LatestMeasurements>({});
  private readonly _profile = signal<LocalBodyProfile | null>(null);
  private readonly _goal = signal<number | null>(null);
  private readonly _today = signal('');
  private ticket = 0;

  /** As primeiras leituras terminaram (o estado vazio só vale depois disto). */
  readonly ready = this._ready.asReadonly();
  readonly entries = this._entries.asReadonly();
  readonly latest = this._latest.asReadonly();
  readonly profile = this._profile.asReadonly();
  /** O dia de hoje do aparelho, `AAAA-MM-DD`. */
  readonly today = this._today.asReadonly();

  /** Uma pesagem por dia, da mais antiga à mais nova, com a tendência. */
  readonly rows = computed(() => weightRows(this._entries()));
  readonly weight = computed(() => summarizeWeight(this._entries(), this.rows(), this._today()));

  /** Idade em anos completos, ou `null` sem perfil. */
  readonly age = computed(() => {
    const profile = this._profile();
    return profile === null ? null : ageYears(profile.birthDate, this._today());
  });

  readonly energy = computed<EnergyState>(() => {
    const profile = this._profile();
    if (profile === null) return { kind: 'no-profile' };
    const age = this.age();
    if (age === null || age < ADULT_AGE_YEARS) return { kind: 'minor' };
    const weight = this.weight();
    if (weight === null) return { kind: 'no-weight' };

    const weightKg = weight.latest.weightKg;
    const bmr = mifflinStJeor({
      weightKg,
      heightCm: profile.heightCm,
      ageYears: age,
      sex: profile.sex,
    });
    if (bmr === null) return { kind: 'minor' };
    const expenditure = tdee(bmr, profile.activityFactor);
    const chosen = this._goal();
    const result = calorieTarget({ chosen: chosen ?? expenditure, bmr });
    return {
      kind: 'ready',
      weightKg,
      bmr,
      factor: profile.activityFactor,
      expenditure,
      chosen,
      target: result.target,
      clamped: result.belowBmr,
    };
  });

  constructor() {
    effect(() => {
      this.body.revision();
      this.profiles.revision();
      this.goals.revision();
      untracked(() => void this.load());
    });
  }

  private async load(): Promise<void> {
    const ticket = ++this.ticket;
    try {
      const [entries, latest, profile, goal] = await Promise.all([
        this.body.entries(),
        this.body.latestMeasurements(),
        this.profiles.get(),
        this.goals.value('daily_kcal'),
      ]);
      if (ticket !== this.ticket) return;
      this._entries.set(entries);
      this._latest.set(latest);
      this._profile.set(profile ?? null);
      this._goal.set(goal);
      this._today.set(this.body.today());
    } catch {
      // Banco que não abre = estado vazio, nunca uma rejeição solta.
      if (ticket !== this.ticket) return;
      this._entries.set([]);
      this._latest.set({});
      this._profile.set(null);
      this._goal.set(null);
      this._today.set(this.body.today());
    }
    this._ready.set(true);
  }
}
