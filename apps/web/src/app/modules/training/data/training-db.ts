import { InjectionToken } from '@angular/core';
import Dexie, { type DexieOptions, type EntityTable } from 'dexie';
import type { LocalBodyEntry } from './body/body-entry';
import type { LocalBodyProfile } from './body/body-profile';
import { accountDatabaseName } from '../../../core/session/account-id';
import type { LocalExercise } from './catalog/exercise';
import type { LocalFood } from './foods/food';
import type { LocalMealEntry } from './meals/meal';
import type { LocalGoal } from './goals/goal';
import type { LocalPhoto } from './photos/photo';
import type {
  LocalAssessmentDocument,
  LocalPhysicalAssessment,
} from './physical-assessments/physical-assessment';
import type { LocalProgram } from './routines/program';
import type { LocalRoutine } from './routines/routine';
import type { LocalSession, LocalSet } from './sessions/session';

/**
 * Banco local do Treino de UMA conta (IndexedDB, via Dexie). É outro banco que o da fila de escrita (`uniover-offline-<id>`):
 * a fila pode ser esvaziada ou migrada sem tocar nos dados do módulo, e vice-versa. Cada conta tem o seu (`trainingDbName`):
 * duas pessoas no mesmo navegador nunca veem os treinos uma da outra.
 *
 * REGRA DE ESQUEMA: mudança de esquema = bloco `version(n)` NOVO. Nunca edite um bloco antigo: o navegador só sabe
 * migrar de uma versão que ele conheceu para a seguinte, e um bloco editado deixa o aparelho que já abriu a versão
 * antiga com um esquema que o código não descreve mais. Cada tarefa que precisa de tabela ou índice novo acrescenta
 * o seu `version(n)` abaixo do último, repetindo só o que muda (o Dexie herda o resto das versões anteriores).
 */

/**
 * Nome do banco do tempo em que havia um só por aparelho (hoje só é lido para a adoção, ver `TrainingAccountDbs`). O banco em
 * uso leva o id da conta no nome.
 */
export const TRAINING_DB_NAME = 'uniover-training';

/** Nome do banco do Treino de uma conta: `uniover-training-<id>`. */
export function trainingDbName(accountId: string): string {
  return accountDatabaseName(TRAINING_DB_NAME, accountId);
}

/**
 * Todas as tabelas do banco antigo (sem conta), copiadas na adoção dele. O banco pode ter sido atualizado para a versão
 * do Corpo antes de receber a separação por conta; fotos e medidas locais precisam ir junto com os treinos.
 */
export const TRAINING_TABLES = [
  'exercises',
  'meta',
  'syncState',
  'routines',
  'program',
  'sessions',
  'sets',
  'goals',
  'bodyEntries',
  'bodyProfile',
  'photos',
  'physicalAssessments',
  'assessmentDocuments',
  'foods',
  'meals',
] as const;

/**
 * Esquema da versão 1, exportado só para o teste de migração abrir o banco exatamente como o aparelho o deixou.
 * `deletedAt` entra no índice, mas linha com `deletedAt: null` não aparece nele (null não é chave do IndexedDB):
 * as leituras filtram a lápide em memória e usam o índice só como atalho para o que tem valor.
 */
export const TRAINING_SCHEMA_V1 = {
  exercises: 'id, slug, *primaryMuscles, equipment, nameKey, deletedAt',
  meta: 'key',
  syncState: 'resource',
} as const;

/**
 * Esquema da versão 2: a tabela das rotinas (a rotina com os itens dentro). `active` não entra no índice: booleano não
 * é chave do IndexedDB, e a lista de rotinas ativas filtra em memória (são poucas). O bloco da versão 1 não foi tocado.
 */
export const TRAINING_SCHEMA_V2 = {
  routines: 'id, position, updatedAt, deletedAt',
} as const;

/**
 * Esquema da versão 3: os treinos ao vivo (`sessions`) e as séries (`sets`). `finishedAt` e `deletedAt` entram nos
 * índices, mas linha com `null` não aparece neles: as leituras filtram em memória. O índice composto
 * `[exerciseId+completedAt]` serve ao histórico de um exercício (e as consultas usam limites explícitos nele). Os
 * blocos das versões 1 e 2 não foram tocados.
 */
export const TRAINING_SCHEMA_V3 = {
  sessions: 'id, startedAt, finishedAt, routineId, deviceId, updatedAt, deletedAt',
  sets: 'id, sessionId, exerciseId, completedAt, [exerciseId+completedAt], deletedAt',
} as const;

/**
 * Esquema da versão 4: as metas do dono. A linha tem como `id` a chave natural (tipo e exercício, ver `goalKey`): o
 * aparelho escreve antes de o servidor dar um id, e `exerciseId` pode ser nulo (que não é chave do IndexedDB), então
 * ele fica só como índice de leitura. Os blocos das versões 1 a 3 não foram tocados.
 */
export const TRAINING_SCHEMA_V4 = {
  goals: 'id, kind, exerciseId, updatedAt, deletedAt',
} as const;

/**
 * Esquema da versão 5: o corpo. `bodyEntries` são as medições (peso, gordura, medidas), com a data local no índice para a
 * linha do tempo; `bodyProfile` guarda UMA linha (altura, nascimento, sexo, fator de atividade; o `id` é fixo); `photos` são
 * as fotos de progresso, que ficam SÓ neste aparelho (nunca entram na fila de escrita nem na leitura do servidor) e só
 * indexam o `id` e a data, porque os bytes (`data`, um `ArrayBuffer`: o WebKit recusa `Blob` no IndexedDB em sessão efêmera)
 * e as dimensões não são consultados. `deletedAt` entra no índice, mas linha com
 * `null` não aparece nele: as leituras filtram a lápide em memória. Os blocos das versões 1 a 4 não foram tocados.
 */
export const TRAINING_SCHEMA_V5 = {
  bodyEntries: 'id, measuredOn, updatedAt, deletedAt',
  bodyProfile: 'id',
  photos: 'id, takenOn',
} as const;

/** Esquema da versão 6: histórico local de avaliações físicas e imagens dos documentos, isoladas das fotos de progresso. */
export const TRAINING_SCHEMA_V6 = {
  physicalAssessments: 'id, assessedOn, updatedAt',
  assessmentDocuments: 'id, assessmentId, addedAt',
} as const;

/** Esquema da versão 7: catálogo de alimentos e diário de refeições, isolados pelo banco da conta. */
export const TRAINING_SCHEMA_V7 = {
  foods: 'id, nameKey, barcode, source, deletedAt',
  meals: 'id, eatenOn, mealType, updatedAt, deletedAt',
} as const;

/**
 * Esquema da versão 8: o programa da semana ativo da conta. UMA linha (o `id` é fixo, `active`), sincronizada como
 * recurso próprio: a escolha feita em outro aparelho chega pelo pull. Os blocos das versões 1 a 7 não foram tocados.
 */
export const TRAINING_SCHEMA_V8 = {
  program: 'id',
} as const;

export interface TrainingMetaRow {
  readonly key: string;
  readonly value: unknown;
}

/** Onde o puxador parou em cada recurso. */
export interface SyncStateRow {
  readonly resource: string;
  /** Último cursor entregue pelo servidor (texto opaco), ou `null` se o recurso nunca foi puxado. */
  readonly cursor: string | null;
  /** Instante (ms) do último puxar que terminou sem erro. */
  readonly lastPullAt: number | null;
}

export class TrainingDb extends Dexie {
  declare exercises: EntityTable<LocalExercise, 'id'>;
  declare foods: EntityTable<LocalFood, 'id'>;
  declare meals: EntityTable<LocalMealEntry, 'id'>;
  declare meta: EntityTable<TrainingMetaRow, 'key'>;
  declare syncState: EntityTable<SyncStateRow, 'resource'>;
  declare routines: EntityTable<LocalRoutine, 'id'>;
  declare program: EntityTable<LocalProgram, 'id'>;
  declare sessions: EntityTable<LocalSession, 'id'>;
  declare sets: EntityTable<LocalSet, 'id'>;
  declare goals: EntityTable<LocalGoal, 'id'>;
  declare bodyEntries: EntityTable<LocalBodyEntry, 'id'>;
  declare bodyProfile: EntityTable<LocalBodyProfile, 'id'>;
  declare photos: EntityTable<LocalPhoto, 'id'>;
  declare physicalAssessments: EntityTable<LocalPhysicalAssessment, 'id'>;
  declare assessmentDocuments: EntityTable<LocalAssessmentDocument, 'id'>;

  constructor(name: string = TRAINING_DB_NAME, options?: DexieOptions) {
    super(name, options);
    this.version(1).stores(TRAINING_SCHEMA_V1);
    this.version(2).stores(TRAINING_SCHEMA_V2);
    this.version(3).stores(TRAINING_SCHEMA_V3);
    this.version(4).stores(TRAINING_SCHEMA_V4);
    this.version(5).stores(TRAINING_SCHEMA_V5);
    this.version(6).stores(TRAINING_SCHEMA_V6);
    this.version(7).stores(TRAINING_SCHEMA_V7);
    this.version(8).stores(TRAINING_SCHEMA_V8);
  }
}

/**
 * O banco do Treino da conta em uso. Sem fábrica padrão de propósito: quem o fornece é o escopo da conta (`TrainingAccountDbs`),
 * nunca um banco único do aparelho, que abriria o nome antigo e misturaria as contas.
 */
export const TRAINING_DB = new InjectionToken<TrainingDb>('TRAINING_DB');

/** Como criar o banco de uma conta a partir do nome dele (o teste troca por uma fábrica em memória). */
export const TRAINING_DB_FACTORY = new InjectionToken<(name: string) => TrainingDb>(
  'TRAINING_DB_FACTORY',
  { providedIn: 'root', factory: () => (name) => new TrainingDb(name) },
);
