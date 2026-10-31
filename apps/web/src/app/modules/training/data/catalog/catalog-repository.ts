import { Injectable, inject, signal } from '@angular/core';
import { musclesOfGroup } from '../../domain/taxonomy';
import { matchesTokens, searchTokens } from '../../domain/text-search';
import { mergeById } from '../sync/merge';
import { TRAINING_DB } from '../training-db';
import { LocalExercise, resolveExercise } from './exercise';

export type CatalogSort = 'name' | 'recent';

/** Filtros combinados (todos juntos, "e"). Campo ausente não filtra. */
export interface CatalogQuery {
  /** Texto livre: acha pelo nome, sem acento e sem caixa; várias palavras = todas precisam aparecer. */
  readonly text?: string;
  /** Id do grupo (`chest`, `back`...): vale o músculo principal do exercício. */
  readonly group?: string;
  /** Id do músculo principal. */
  readonly muscle?: string;
  readonly equipment?: string;
  /** `name` (padrão): alfabética · `recent`: o alterado há menos tempo primeiro. */
  readonly sort?: CatalogSort;
}

/**
 * Único ponto de acesso à tabela de exercícios. A tela lê daqui, sempre do banco local e sem rede, e nunca vê
 * lápide: o exercício apagado some das leituras, mas a linha continua guardada para o apagamento valer em todo
 * aparelho.
 *
 * Filtrar por músculo ou grupo olha só o músculo **principal** (é o que o índice cobre e o que o usuário espera ao
 * filtrar "peito"); o secundário aparece na ficha, não no filtro.
 */
@Injectable()
export class CatalogRepository {
  private readonly db = inject(TRAINING_DB);
  private readonly _revision = signal(0);

  /** Sobe a cada gravação neste aparelho; quem mostra a lista relê quando muda. */
  readonly revision = this._revision.asReadonly();

  async search(query: CatalogQuery = {}): Promise<LocalExercise[]> {
    const rows = await this.collect(query).toArray();
    return query.sort === 'recent' ? rows.sort(byRecent) : rows.sort(byName);
  }

  /** Quantos passam no filtro. Conta no banco, sem trazer as linhas para a memória (o catálogo inteiro tem centenas). */
  count(query: CatalogQuery = {}): Promise<number> {
    return this.collect(query).count();
  }

  /** O exercício vivo, ou `undefined` se não existe ou foi apagado. */
  async get(id: string): Promise<LocalExercise | undefined> {
    const row = await this.db.exercises.get(id);
    return row !== undefined && row.deletedAt === null ? row : undefined;
  }

  /** Funde o que veio do servidor (ver `resolveExercise`). Nunca apaga linha por ausência. */
  async applyRemote(remote: readonly LocalExercise[]): Promise<void> {
    if (remote.length === 0) return;
    await this.db.transaction('rw', this.db.exercises, async () => {
      const found = await this.db.exercises.bulkGet(remote.map((row) => row.id));
      const local = new Map<string, LocalExercise>();
      for (const row of found) if (row) local.set(row.id, row);
      const writes = mergeById(local, remote, resolveExercise);
      if (writes.length > 0) await this.db.exercises.bulkPut(writes);
    });
    this.touch();
  }

  /** Grava uma escrita feita neste aparelho (exercício próprio ou salto de carga). */
  async writeLocal(row: LocalExercise): Promise<void> {
    await this.db.exercises.put(row);
    this.touch();
  }

  /**
   * Desfaz uma gravação local que a fila recusou. Só mexe se a linha ainda é a que foi gravada (nada mais a
   * alterou nesse meio tempo): volta ao estado anterior, ou remove a linha se ela nem existia.
   */
  async undoLocal(written: LocalExercise, previous: LocalExercise | undefined): Promise<void> {
    await this.db.transaction('rw', this.db.exercises, async () => {
      const current = await this.db.exercises.get(written.id);
      if (!sameWrite(current, written)) return;
      if (previous) await this.db.exercises.put(previous);
      else await this.db.exercises.delete(written.id);
    });
    this.touch();
  }

  /** Lê a linha como está, lápide inclusa (quem escreve precisa do estado anterior exato). */
  readRaw(id: string): Promise<LocalExercise | undefined> {
    return this.db.exercises.get(id);
  }

  private touch(): void {
    this._revision.update((value) => value + 1);
  }

  private collect(query: CatalogQuery) {
    const tokens = searchTokens(query.text ?? '');
    const groupMuscles = query.group ? musclesOfGroup(query.group) : null;
    const groupSet = groupMuscles ? new Set<string>(groupMuscles) : null;
    const table = this.db.exercises;

    // O índice é só atalho: escolhe o filtro mais seletivo disponível e o resto confere em memória.
    let source: ReturnType<typeof table.toCollection>;
    if (query.equipment) source = table.where('equipment').equals(query.equipment);
    else if (query.muscle) source = table.where('primaryMuscles').equals(query.muscle);
    else if (groupMuscles) source = table.where('primaryMuscles').anyOf(groupMuscles).distinct();
    else source = table.toCollection();

    return source.filter(
      (row) =>
        row.deletedAt === null &&
        (!query.equipment || row.equipment === query.equipment) &&
        (!query.muscle || row.primaryMuscles.includes(query.muscle)) &&
        (!groupSet || row.primaryMuscles.some((muscle) => groupSet.has(muscle))) &&
        matchesTokens(row.nameKey, tokens),
    );
  }
}

function sameWrite(current: LocalExercise | undefined, written: LocalExercise): boolean {
  return (
    current !== undefined &&
    current.clientUpdatedAt === written.clientUpdatedAt &&
    current.stepClientUpdatedAt === written.stepClientUpdatedAt &&
    current.deletedAt === written.deletedAt
  );
}

function byName(a: LocalExercise, b: LocalExercise): number {
  if (a.nameKey !== b.nameKey) return a.nameKey < b.nameKey ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function byRecent(a: LocalExercise, b: LocalExercise): number {
  const latest = (row: LocalExercise) =>
    Math.max(row.clientUpdatedAt, row.stepClientUpdatedAt ?? 0);
  return latest(b) - latest(a) || byName(a, b);
}
