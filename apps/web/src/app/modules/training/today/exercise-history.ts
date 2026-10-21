import { Injectable, inject } from '@angular/core';
import type { ProgressSet } from '../domain/progress/series';
import { SessionRepository } from '../data/sessions/session-repository';

/**
 * As séries que cada exercício já teve em **outros** treinos, para dizer se a série de agora bate um recorde. O repositório
 * não tem uma consulta "todas as séries do exercício"; aqui elas são montadas dos treinos vivos, uma passada só para todos
 * os exercícios pedidos, e guardadas até a tela sair (o histórico antigo não muda durante o treino).
 */
@Injectable()
export class ExerciseHistory {
  private readonly sessions = inject(SessionRepository);
  private readonly cache = new Map<string, ProgressSet[]>();

  /** Esquece o que guardou: o histórico mudou (a leitura do servidor trouxe treinos novos). */
  clear(): void {
    this.cache.clear();
  }

  /** As séries antigas de cada exercício pedido, sem as do treino `excludeSessionId` (o de hoje). */
  async before(
    exerciseIds: readonly string[],
    excludeSessionId: string,
  ): Promise<Map<string, readonly ProgressSet[]>> {
    const key = (id: string) => `${excludeSessionId}|${id}`;
    const wanted = [...new Set(exerciseIds)];
    const missing = new Set(wanted.filter((id) => !this.cache.has(key(id))));

    if (missing.size > 0) {
      const found = new Map<string, ProgressSet[]>([...missing].map((id) => [id, []]));
      for (const session of await this.sessions.sessionsBetween(0, Number.MAX_SAFE_INTEGER)) {
        if (session.id === excludeSessionId) continue;
        for (const set of await this.sessions.setsOfSession(session.id)) {
          found.get(set.exerciseId)?.push({
            sessionId: session.id,
            setType: set.setType,
            weightKg: set.weightKg,
            reps: set.reps,
            completedAt: set.completedAt,
          });
        }
      }
      for (const [id, sets] of found) this.cache.set(key(id), sets);
    }

    return new Map(wanted.map((id) => [id, this.cache.get(key(id)) ?? []]));
  }
}
