import { HttpErrorResponse } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { IDBFactory as FakeIDBFactory, IDBKeyRange as FakeIDBKeyRange } from 'fake-indexeddb';
import { TEST_ACCOUNT, setupQueue } from '../../../../core/offline-queue/queue-test-kit';
import { ExerciseDto, LocalExercise, toLocalExercise } from '../catalog/exercise';
import {
  TRAINING_DB,
  TRAINING_DB_FACTORY,
  TRAINING_DB_NAME,
  TrainingDb,
  trainingDbName,
} from '../training-db';
import { provideTrainingData } from '../training-data.providers';
import { PullApi } from './pull-api';
import type { PullPage } from './resource-sync';

/**
 * Peças de teste da camada de dados do Treino: banco em memória, leitura incremental roteirizada e a fila de
 * escrita já com as portas falsas. Só os testes importam este arquivo; nada daqui entra no bundle do app.
 */

let databaseCounter = 0;

/** Banco isolado por teste (fábrica própria do IndexedDB e nome único); a mesma fábrica simula reabrir o app. */
export function createTrainingTestDb(factory: IDBFactory = new FakeIDBFactory()): TrainingDb {
  databaseCounter++;
  return new TrainingDb(`uniover-training-teste-${databaseCounter}`, {
    indexedDB: factory,
    IDBKeyRange: FakeIDBKeyRange,
  });
}

const DEFAULT_DTO: Omit<ExerciseDto, 'id'> = {
  slug: 'exercise',
  source: 'free_exercise_db',
  sourceRef: 'ref',
  name: 'Exercício',
  instructions: ['Faça o movimento.'],
  primaryMuscles: ['chest'],
  secondaryMuscles: [],
  equipment: 'barbell',
  recordType: 'weight_reps',
  stepKg: null,
  stepClientUpdatedAt: null,
  level: null,
  category: null,
  mechanic: null,
  license: null,
  licenseAuthor: null,
  licenseUrl: null,
  reviewed: false,
  updatedAt: '2026-10-01T10:00:00.0000000+00:00',
  clientUpdatedAt: '2026-10-01T10:00:00.0000000+00:00',
  deleted: false,
};

/** Resposta da API com valores razoáveis; o teste sobrescreve só o que importa. */
export function exerciseDto(id: string, overrides: Partial<ExerciseDto> = {}): ExerciseDto {
  return { ...DEFAULT_DTO, id, slug: id, ...overrides };
}

/** Linha local equivalente a `exerciseDto`. */
export function localExercise(id: string, overrides: Partial<ExerciseDto> = {}): LocalExercise {
  return toLocalExercise(exerciseDto(id, overrides));
}

export interface PullCall {
  readonly path: string;
  readonly after: string | null;
  readonly limit: number;
  readonly accountId: string;
}

type Scripted = PullPage<unknown> | Error | HttpErrorResponse | (() => Promise<PullPage<unknown>>);

/** Leitura incremental falsa: devolve o roteiro na ordem; depois dele, uma página vazia. */
export class FakePullApi {
  readonly calls: PullCall[] = [];
  script: Scripted[] = [];
  /** Enquanto definido, toda leitura espera por ele (mantém a passada em andamento). */
  gate: Promise<void> | null = null;
  inFlight = 0;
  maxInFlight = 0;

  async fetchPage<T>(
    path: string,
    after: string | null,
    limit: number,
    accountId: string,
  ): Promise<PullPage<T>> {
    this.calls.push({ path, after, limit, accountId });
    this.inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      if (this.gate) await this.gate;
      const next = this.script.shift();
      if (next instanceof Error || next instanceof HttpErrorResponse) throw next;
      if (typeof next === 'function') return (await next()) as PullPage<T>;
      return (next ?? { items: [], nextCursor: null }) as PullPage<T>;
    } finally {
      this.inFlight--;
    }
  }
}

/**
 * Monta o TestBed com a fila falsa, o banco do Treino em memória e a leitura roteirizada. `db` é o banco da conta de teste (o
 * mesmo que as telas e os repositórios recebem); o de outras contas (`trainingDbOf`) e o banco antigo (`trainingLegacyDb`)
 * moram na mesma fábrica falsa do IndexedDB da fila, então reabrir é achar os mesmos dados.
 */
export function setupTraining(db: TrainingDb = createTrainingTestDb()) {
  const queue = setupQueue();
  const pull = new FakePullApi();
  const others = new Map<string, TrainingDb>();
  const trainingDbOf = (accountId: string): TrainingDb => {
    if (accountId === TEST_ACCOUNT) return db;
    let other = others.get(accountId);
    if (!other) {
      other = new TrainingDb(trainingDbName(accountId), queue.dbOptions);
      others.set(accountId, other);
    }
    return other;
  };
  TestBed.configureTestingModule({
    providers: [
      { provide: TRAINING_DB, useValue: db },
      {
        provide: TRAINING_DB_FACTORY,
        useValue: (name: string) =>
          name === trainingDbName(TEST_ACCOUNT) ? db : new TrainingDb(name, queue.dbOptions),
      },
      { provide: PullApi, useValue: pull },
      provideTrainingData(),
    ],
  });
  return {
    ...queue,
    trainingDb: db,
    trainingDbOf,
    /** O banco do tempo em que havia um só por aparelho, na mesma fábrica falsa (para o teste de adoção). */
    trainingLegacyDb: () => new TrainingDb(TRAINING_DB_NAME, queue.dbOptions),
    pull,
  };
}
