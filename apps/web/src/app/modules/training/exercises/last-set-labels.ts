import { Injectable, inject, signal } from '@angular/core';
import type { LocalExercise } from '../data/catalog/exercise';
import { SessionRepository } from '../data/sessions/session-repository';
import { summarizeLastSets } from './last-set';

type Asked = Pick<LocalExercise, 'id' | 'recordType'>;

/**
 * "Seu último" das linhas visíveis da lista. Lê só dos exercícios que a tela mostra (uma consulta por exercício, em
 * ordem, sem travar a lista) e guarda o resultado: rolar ou voltar à lista não pergunta de novo. O texto `null` é
 * "sem registro"; exercício ainda não lido não está no mapa.
 */
@Injectable()
export class LastSetLabels {
  private readonly sessions = inject(SessionRepository);
  private readonly _labels = signal<ReadonlyMap<string, string | null>>(new Map());
  private readonly asked = new Set<string>();
  private queue: Promise<void> = Promise.resolve();

  readonly labels = this._labels.asReadonly();

  /** Pede o texto dos exercícios que ainda não foram lidos. Pode ser chamado a cada mudança da lista. */
  request(exercises: readonly Asked[]): void {
    const missing = exercises.filter((exercise) => !this.asked.has(exercise.id));
    if (missing.length === 0) return;
    for (const exercise of missing) this.asked.add(exercise.id);
    this.queue = this.queue.then(() => this.read(missing));
  }

  private async read(exercises: readonly Asked[]): Promise<void> {
    const found = new Map<string, string | null>();
    for (const exercise of exercises) {
      try {
        const last = await this.sessions.lastPerformance(exercise.id);
        found.set(exercise.id, last ? summarizeLastSets(last.sets, exercise.recordType) : null);
      } catch {
        // Uma leitura que falha deixa a linha só sem o "seu último": a lista não depende dele.
        found.set(exercise.id, null);
      }
    }
    this._labels.update((current) => new Map([...current, ...found]));
  }
}
