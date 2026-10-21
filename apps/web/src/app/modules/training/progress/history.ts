import { Injectable, effect, inject, signal, untracked } from '@angular/core';
import type { LocalSession, LocalSet } from '../data/sessions/session';
import { SessionRepository } from '../data/sessions/session-repository';

/** Um exercício com carga e repetições registradas, e quando foi feito pela última vez. */
export interface HistoryExercise {
  readonly id: string;
  readonly lastAt: number;
}

export interface TrainingHistory {
  /** Exercícios com histórico de carga, do treinado mais recentemente ao mais antigo. */
  readonly exercises: readonly HistoryExercise[];
  /** Os treinos que contam (com ao menos uma série de trabalho), do mais antigo ao mais novo. */
  readonly sessions: readonly { readonly startedAt: number }[];
}

export const EMPTY_HISTORY: TrainingHistory = { exercises: [], sessions: [] };

/** Quantos treinos se leem de uma vez do banco local. */
const BATCH = 40;

/**
 * Resume os treinos e as séries deles: quais exercícios têm histórico de carga (série de trabalho com carga e repetições)
 * e quais treinos contam (só aquecimento não é treino). Função pura: o teste monta os treinos à mão.
 */
export function summarizeHistory(
  sessions: readonly Pick<LocalSession, 'id' | 'startedAt'>[],
  setsOf: (
    sessionId: string,
  ) => readonly Pick<LocalSet, 'exerciseId' | 'setType' | 'weightKg' | 'reps' | 'completedAt'>[],
): TrainingHistory {
  const lastAt = new Map<string, number>();
  const counted: { startedAt: number }[] = [];

  for (const session of sessions) {
    const work = setsOf(session.id).filter((set) => set.setType !== 'warmup');
    if (work.length === 0) continue;
    counted.push({ startedAt: session.startedAt });
    for (const set of work) {
      if (set.weightKg === null || set.weightKg <= 0 || set.reps === null || set.reps <= 0) {
        continue;
      }
      lastAt.set(set.exerciseId, Math.max(lastAt.get(set.exerciseId) ?? 0, set.completedAt));
    }
  }

  return {
    exercises: [...lastAt]
      .map(([id, last]) => ({ id, lastAt: last }))
      .sort((a, b) => b.lastAt - a.lastAt || a.id.localeCompare(b.id)),
    sessions: counted.sort((a, b) => a.startedAt - b.startedAt),
  };
}

/**
 * O histórico de treinos do aparelho, para a lista de exercícios do gráfico e para a constância. Lê só pelo repositório de
 * treinos, sem esperar a rede, e se atualiza sozinho quando chegam ou se gravam séries. Fica no injetor da tela:
 * as seções que precisam dele leem o mesmo resultado, e a leitura se faz uma vez.
 */
@Injectable()
export class ProgressHistory {
  private readonly repository = inject(SessionRepository);
  private readonly _data = signal<TrainingHistory | null>(null);
  private ticket = 0;

  /** `null` enquanto lê pela primeira vez. */
  readonly data = this._data.asReadonly();

  constructor() {
    effect(() => {
      this.repository.revision();
      untracked(() => void this.refresh());
    });
  }

  private async refresh(): Promise<void> {
    const ticket = ++this.ticket;
    const sessions = await this.repository.sessionsBetween(0, Number.MAX_SAFE_INTEGER);
    const bySession = new Map<string, readonly LocalSet[]>();
    for (let start = 0; start < sessions.length; start += BATCH) {
      const batch = sessions.slice(start, start + BATCH);
      const sets = await Promise.all(
        batch.map((session) => this.repository.setsOfSession(session.id)),
      );
      batch.forEach((session, index) => bySession.set(session.id, sets[index]));
      if (ticket !== this.ticket) return;
    }
    this._data.set(summarizeHistory(sessions, (id) => bySession.get(id) ?? []));
  }
}
