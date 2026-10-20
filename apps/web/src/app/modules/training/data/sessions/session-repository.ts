import { Injectable, inject, signal } from '@angular/core';
import { OfflineQueue } from '../../../../core/offline-queue/offline-queue';
import { QueueStorageFullError } from '../../../../core/offline-queue/outbox-store';
import { QUEUE_RUNTIME } from '../../../../core/offline-queue/queue-ports';
import { uuidV7 } from '../../../../core/offline-queue/uuid-v7';
import {
  DEFAULT_SET_TYPE,
  type FinishIssueCode,
  type SetIssue,
  type SetType,
  type SetValues,
  isWorkingSet,
  validateFinish,
  validateSet,
} from '../../domain/session/session-model';
import { mergeById } from '../sync/merge';
import { TRAINING_DB } from '../training-db';
import {
  type LocalSession,
  type LocalSet,
  resolveSession,
  resolveSet,
  toSessionBody,
  toSetBody,
} from './session';
import { sessionPath, setPath } from './session-api';

/** O que a tela entrega ao concluir uma série. Só o `exerciseId` é obrigatório; o resto assume o padrão. */
export interface SetDraft {
  readonly exerciseId: string;
  readonly setType?: SetType;
  readonly weightKg?: number | null;
  readonly reps?: number | null;
  readonly durationS?: number | null;
  readonly rir?: number | null;
  readonly rpe?: number | null;
  readonly note?: string;
  /** Padrão: agora. */
  readonly completedAt?: number;
}

/** O que a tela muda numa série já gravada; campo ausente mantém o que a série tinha. */
export type SetChanges = Partial<SetValues>;

/**
 * Resultado de iniciar o treino. `already-active`: este aparelho já tem um treino aberto (devolve-o). `open-elsewhere`:
 * outro aparelho tem um treino em andamento (pelo que este aparelho sabe da última leitura) e **só um aparelho treina
 * por vez**: nada foi aberto. `storage-full`: sem espaço para guardar o pedido, nada ficou gravado.
 */
export type StartResult =
  | { readonly status: 'started'; readonly session: LocalSession }
  | { readonly status: 'already-active'; readonly session: LocalSession }
  | { readonly status: 'open-elsewhere'; readonly session: LocalSession }
  | { readonly status: 'storage-full' };

/**
 * Resultado de uma escrita numa série. `invalid`: a série não passa nos limites ou na forma do exercício (`issues` diz
 * o campo). `exercise-not-found`: o exercício não existe neste aparelho. `no-active-session`: não há treino aberto.
 */
export type SetWriteResult =
  | { readonly status: 'saved'; readonly set: LocalSet }
  | { readonly status: 'invalid'; readonly issues: readonly SetIssue[] }
  | { readonly status: 'exercise-not-found' }
  | { readonly status: 'no-active-session' }
  | { readonly status: 'not-found' }
  | { readonly status: 'storage-full' };

/** Resultado de encerrar, apagar ou fechar um treino. */
export type SessionWriteResult =
  | { readonly status: 'saved'; readonly session: LocalSession }
  | { readonly status: 'invalid'; readonly issues: readonly FinishIssueCode[] }
  | { readonly status: 'no-active-session' }
  | { readonly status: 'not-found' }
  | { readonly status: 'storage-full' };

/**
 * Resultado de reenviar um treino. `queued`: o treino (e as séries dele) entraram na fila de novo, com chaves novas.
 * `not-found`: o treino não existe neste aparelho.
 */
export type ResendResult =
  | { readonly status: 'queued'; readonly requests: number }
  | { readonly status: 'not-found' }
  | { readonly status: 'storage-full' };

/** A última vez que o exercício foi feito: a sessão e as séries de trabalho dela, em ordem de execução. */
export interface LastPerformance {
  readonly sessionId: string;
  readonly finishedAt: number;
  readonly sets: readonly LocalSet[];
}

interface PendingWrite {
  readonly table: 'sessions' | 'sets';
  readonly written: LocalSession | LocalSet;
  readonly previous: LocalSession | LocalSet | undefined;
  /** `false` na linha que só muda aqui (o servidor faz a mesma mudança sozinho, como as séries de um treino apagado). */
  readonly enqueue: boolean;
}

interface MetaChange {
  readonly put?: Readonly<Record<string, unknown>>;
  readonly remove?: readonly string[];
}

const QUEUE_MODULE = 'training';
const META_DEVICE_ID = 'deviceId';
const META_ACTIVE_SESSION = 'activeSessionId';
/** Fim do descanso (ms); quem lê e escreve é o timer, o repositório só o apaga ao encerrar o treino. */
export const META_REST_ENDS_AT = 'restEndsAt';
const META_SKIPPED = 'skippedExercises';
/** Fim do intervalo de busca do histórico (o maior inteiro seguro: limite explícito, nunca `Dexie.maxKey`). */
const MAX_TIME = Number.MAX_SAFE_INTEGER;
const HISTORY_PAGE = 50;

/**
 * Único ponto de acesso ao treino ao vivo. A tela lê daqui, sempre do banco local e sem rede, e nunca vê lápide.
 *
 * Escrever = gravar no banco local **e** enfileirar um `PUT` (um por treino ou série escrita). A ordem da fila é a do uso:
 * o treino entra antes das séries e as séries antes do fim, porque cada escrita é enfileirada quando acontece. Se a fila
 * recusar por falta de espaço, a gravação local é desfeita: nada fica pela metade. A **edição** de uma série já enviada
 * é um novo `PUT` com `clientUpdatedAt` maior (não se usa `OfflineQueue.update`).
 *
 * Um aparelho por vez: `start` recusa abrir um treino quando se sabe de outro aberto em outro aparelho, e o servidor
 * recusa o segundo de qualquer forma (409). **Nenhuma escrita aqui depende de sessão de login**: um 401 ou um logout não
 * apagam nada, nem da fila nem do banco local.
 */
@Injectable()
export class SessionRepository {
  private readonly db = inject(TRAINING_DB);
  private readonly queue = inject(OfflineQueue);
  private readonly runtime = inject(QUEUE_RUNTIME);
  private readonly _revision = signal(0);

  /** Sobe a cada gravação neste aparelho; quem mostra a tela relê quando muda. */
  readonly revision = this._revision.asReadonly();

  /** Id deste aparelho: um UUID v7 gerado uma vez e guardado (não muda enquanto o banco local existir). */
  async deviceId(): Promise<string> {
    const existing = await this.db.meta.get(META_DEVICE_ID);
    if (typeof existing?.value === 'string') return existing.value;
    return this.db.transaction('rw', this.db.meta, async () => {
      // Releitura dentro da transação: duas chamadas ao mesmo tempo terminam com o mesmo id.
      const again = await this.db.meta.get(META_DEVICE_ID);
      if (typeof again?.value === 'string') return again.value;
      const id = uuidV7();
      await this.db.meta.put({ key: META_DEVICE_ID, value: id });
      return id;
    });
  }

  /**
   * O treino aberto deste aparelho, ou `undefined`. O ponteiro (`activeSessionId`) é conferido contra a linha: se o treino
   * foi encerrado ou apagado em outro lugar (o puxar trouxe isso), o ponteiro velho é limpo.
   */
  async activeSession(): Promise<LocalSession | undefined> {
    const pointer = (await this.db.meta.get(META_ACTIVE_SESSION))?.value;
    if (typeof pointer !== 'string') return undefined;

    const row = await this.db.sessions.get(pointer);
    if (
      row !== undefined &&
      row.deletedAt === null &&
      row.finishedAt === null &&
      row.deviceId === (await this.deviceId())
    ) {
      return row;
    }
    await this.db.meta.delete(META_ACTIVE_SESSION);
    return undefined;
  }

  /**
   * Treinos abertos em **outro** aparelho há pelo menos `olderThanMs` (0 = qualquer um), segundo o que este aparelho já
   * puxou do servidor, do mais antigo para o mais novo.
   */
  async openSessionsElsewhere(olderThanMs = 0): Promise<LocalSession[]> {
    const mine = await this.deviceId();
    const limit = this.runtime.now() - olderThanMs;
    const rows = await this.db.sessions.toArray();
    return rows
      .filter(
        (row) =>
          row.deletedAt === null &&
          row.finishedAt === null &&
          row.deviceId !== mine &&
          // Sem idade mínima, vale qualquer um (o relógio de outro aparelho pode estar adiantado em relação a este).
          (olderThanMs <= 0 || row.startedAt <= limit),
      )
      .sort((a, b) => a.startedAt - b.startedAt);
  }

  /** Abre o treino (a partir de uma rotina ou livre). Ver `StartResult`. */
  async start(routineId: string | null = null): Promise<StartResult> {
    const active = await this.activeSession();
    if (active) return { status: 'already-active', session: active };

    const [elsewhere] = await this.openSessionsElsewhere();
    if (elsewhere) return { status: 'open-elsewhere', session: elsewhere };

    const stamp = this.runtime.now();
    const session: LocalSession = {
      id: uuidV7(),
      routineId,
      startedAt: stamp,
      finishedAt: null,
      note: '',
      feeling: null,
      deviceId: await this.deviceId(),
      updatedAt: stamp,
      clientUpdatedAt: stamp,
      deletedAt: null,
    };
    const saved = await this.commit(
      [{ table: 'sessions', written: session, previous: undefined, enqueue: true }],
      {
        put: { [META_ACTIVE_SESSION]: session.id },
        remove: [META_REST_ENDS_AT, META_SKIPPED],
      },
    );
    return saved ? { status: 'started', session } : { status: 'storage-full' };
  }

  /** Conclui uma série: grava no aparelho na hora e enfileira o `PUT`. */
  async addSet(draft: SetDraft): Promise<SetWriteResult> {
    const active = await this.activeSession();
    if (!active) return { status: 'no-active-session' };

    const exercise = await this.db.exercises.get(draft.exerciseId);
    if (exercise === undefined || exercise.deletedAt !== null)
      return { status: 'exercise-not-found' };

    const values: SetValues = {
      setType: draft.setType ?? DEFAULT_SET_TYPE,
      weightKg: draft.weightKg ?? null,
      reps: draft.reps ?? null,
      durationS: draft.durationS ?? null,
      rir: draft.rir ?? null,
      rpe: draft.rpe ?? null,
      note: (draft.note ?? '').trim(),
    };
    const issues = validateSet(values, exercise.recordType);
    if (issues.length > 0) return { status: 'invalid', issues };

    const existing = await this.db.sets.where('sessionId').equals(active.id).toArray();
    const stamp = this.runtime.now();
    const set: LocalSet = {
      id: uuidV7(),
      sessionId: active.id,
      exerciseId: draft.exerciseId,
      position: existing.length === 0 ? 0 : Math.max(...existing.map((row) => row.position)) + 1,
      ...values,
      completedAt: draft.completedAt ?? stamp,
      updatedAt: stamp,
      clientUpdatedAt: stamp,
      deletedAt: null,
    };
    const saved = await this.commit([
      { table: 'sets', written: set, previous: undefined, enqueue: true },
    ]);
    return saved ? { status: 'saved', set } : { status: 'storage-full' };
  }

  /** Edita uma série (também a de um treino já encerrado): novo `PUT` com `clientUpdatedAt` maior. */
  async editSet(id: string, changes: SetChanges): Promise<SetWriteResult> {
    const previous = await this.db.sets.get(id);
    if (previous === undefined || previous.deletedAt !== null) return { status: 'not-found' };

    const values: SetValues = {
      setType: changes.setType ?? previous.setType,
      weightKg: changes.weightKg === undefined ? previous.weightKg : changes.weightKg,
      reps: changes.reps === undefined ? previous.reps : changes.reps,
      durationS: changes.durationS === undefined ? previous.durationS : changes.durationS,
      rir: changes.rir === undefined ? previous.rir : changes.rir,
      rpe: changes.rpe === undefined ? previous.rpe : changes.rpe,
      note: (changes.note ?? previous.note).trim(),
    };
    const exercise = await this.db.exercises.get(previous.exerciseId);
    const issues = validateSet(values, exercise?.recordType ?? null);
    if (issues.length > 0) return { status: 'invalid', issues };

    const stamp = this.nextStamp(previous.clientUpdatedAt);
    const set: LocalSet = { ...previous, ...values, updatedAt: stamp, clientUpdatedAt: stamp };
    const saved = await this.commit([{ table: 'sets', written: set, previous, enqueue: true }]);
    return saved ? { status: 'saved', set } : { status: 'storage-full' };
  }

  /** Apaga a série por lápide (o `PUT` leva `deleted: true`; nunca um `DELETE`). */
  async deleteSet(id: string): Promise<SetWriteResult> {
    const previous = await this.db.sets.get(id);
    if (previous === undefined || previous.deletedAt !== null) return { status: 'not-found' };

    const stamp = this.nextStamp(previous.clientUpdatedAt);
    const set: LocalSet = {
      ...previous,
      updatedAt: stamp,
      clientUpdatedAt: stamp,
      deletedAt: stamp,
    };
    const saved = await this.commit([{ table: 'sets', written: set, previous, enqueue: true }]);
    return saved ? { status: 'saved', set } : { status: 'storage-full' };
  }

  /** Encerra o treino aberto: instante de fim, sensação e anotação opcionais. Libera o aparelho para um novo treino. */
  async finish(
    options: { feeling?: number | null; note?: string } = {},
  ): Promise<SessionWriteResult> {
    const active = await this.activeSession();
    if (!active) return { status: 'no-active-session' };
    return this.close(active, options, {
      remove: [META_ACTIVE_SESSION, META_REST_ENDS_AT, META_SKIPPED],
    });
  }

  /**
   * Fecha um treino que ficou aberto em **outro** aparelho (por exemplo, o celular que ficou sem bateria): sem isto, um
   * aparelho perdido bloquearia o treino para sempre. O treino é encerrado na hora atual e continua sendo do aparelho que
   * o abriu. Só vale para treino vivo, aberto e de outro aparelho.
   */
  async closeElsewhere(sessionId: string): Promise<SessionWriteResult> {
    const row = await this.db.sessions.get(sessionId);
    if (
      row === undefined ||
      row.deletedAt !== null ||
      row.finishedAt !== null ||
      row.deviceId === (await this.deviceId())
    ) {
      return { status: 'not-found' };
    }
    return this.close(row, {}, {});
  }

  /** Descarta o treino aberto por lápide (as séries dele somem junto, também no servidor). */
  async discard(): Promise<SessionWriteResult> {
    const active = await this.activeSession();
    if (!active) return { status: 'no-active-session' };

    const stamp = this.nextStamp(active.clientUpdatedAt);
    const session: LocalSession = {
      ...active,
      updatedAt: stamp,
      clientUpdatedAt: stamp,
      deletedAt: stamp,
    };
    const writes: PendingWrite[] = [
      { table: 'sessions', written: session, previous: active, enqueue: true },
    ];

    // O servidor apaga as séries sozinho; aqui só se espelha, sem enfileirar nada.
    const sets = await this.db.sets.where('sessionId').equals(active.id).toArray();
    for (const previous of sets) {
      if (previous.deletedAt !== null) continue;
      writes.push({
        table: 'sets',
        written: { ...previous, updatedAt: stamp, clientUpdatedAt: stamp, deletedAt: stamp },
        previous,
        enqueue: false,
      });
    }

    const saved = await this.commit(writes, {
      remove: [META_ACTIVE_SESSION, META_REST_ENDS_AT, META_SKIPPED],
    });
    return saved ? { status: 'saved', session } : { status: 'storage-full' };
  }

  /**
   * Reenvia um treino inteiro (o treino e as séries dele) como pedidos **novos**, e tira da fila os pedidos dele que o
   * servidor recusou. É a saída para o caso em que o treino foi recusado (por exemplo, outro aparelho tinha um treino
   * aberto) e as séries foram recusadas junto: o servidor guarda a recusa por chave, então "tentar de novo" o mesmo item
   * devolve a recusa antiga mesmo depois de o motivo passar; já um pedido novo chega. O conteúdo é o mesmo que já está
   * no aparelho, e o servidor aceita o reenvio sem duplicar.
   */
  async resendSession(sessionId: string): Promise<ResendResult> {
    const session = await this.db.sessions.get(sessionId);
    if (session === undefined) return { status: 'not-found' };

    // Treino apagado: só a lápide importa (o servidor apaga as séries sozinho).
    const sets =
      session.deletedAt === null
        ? (await this.db.sets.where('sessionId').equals(sessionId).toArray()).sort(
            (a, b) => a.position - b.position || a.completedAt - b.completedAt,
          )
        : [];

    const queued: string[] = [];
    try {
      queued.push(
        await this.queue.enqueue({
          method: 'PUT',
          module: QUEUE_MODULE,
          url: sessionPath(session.id),
          body: toSessionBody(session),
        }),
      );
      for (const set of sets) {
        queued.push(
          await this.queue.enqueue({
            method: 'PUT',
            module: QUEUE_MODULE,
            url: setPath(sessionId, set.id),
            body: toSetBody(set),
          }),
        );
      }
    } catch (error) {
      for (const key of queued) await this.queue.discard(key);
      if (error instanceof QueueStorageFullError) return { status: 'storage-full' };
      throw error;
    }

    // Os pedidos recusados deste treino saem: os novos os substituem.
    const base = sessionPath(sessionId);
    for (const item of await this.queue.items()) {
      const ofThisSession = item.url === base || item.url.startsWith(`${base}/`);
      if (item.status === 'failed' && ofThisSession && !queued.includes(item.id)) {
        await this.queue.discard(item.id);
      }
    }
    return { status: 'queued', requests: queued.length };
  }

  /** As séries vivas de um treino, na ordem em que foram feitas. */
  async setsOfSession(sessionId: string): Promise<LocalSet[]> {
    const rows = await this.db.sets.where('sessionId').equals(sessionId).toArray();
    return rows
      .filter((row) => row.deletedAt === null)
      .sort((a, b) => a.position - b.position || a.completedAt - b.completedAt);
  }

  /** O treino vivo (aberto ou encerrado), ou `undefined`. */
  async get(id: string): Promise<LocalSession | undefined> {
    const row = await this.db.sessions.get(id);
    return row !== undefined && row.deletedAt === null ? row : undefined;
  }

  /** Os treinos vivos que começaram entre `from` e `to` (ms, extremos incluídos), do mais antigo ao mais novo. */
  async sessionsBetween(from: number, to: number): Promise<LocalSession[]> {
    const rows = await this.db.sessions.where('startedAt').between(from, to, true, true).toArray();
    return rows.filter((row) => row.deletedAt === null).sort((a, b) => a.startedAt - b.startedAt);
  }

  /**
   * A última vez que o exercício foi feito: as séries de **trabalho** da sessão **encerrada** mais recente que as teve.
   * Sessão aberta, apagada e séries de aquecimento ou apagadas não contam. É o que pré-preenche "a mesma série da última
   * vez" (ver `prefillFor`).
   */
  async lastPerformance(exerciseId: string): Promise<LastPerformance | null> {
    const history = () =>
      this.db.sets
        .where('[exerciseId+completedAt]')
        .between([exerciseId, 0], [exerciseId, MAX_TIME], true, true)
        .reverse();

    let found: LocalSession | undefined;
    for (let offset = 0; found === undefined; offset += HISTORY_PAGE) {
      const batch = await history().offset(offset).limit(HISTORY_PAGE).toArray();
      if (batch.length === 0) return null;
      for (const set of batch) {
        if (set.deletedAt !== null || !isWorkingSet(set.setType)) continue;
        const session = await this.db.sessions.get(set.sessionId);
        if (session && session.deletedAt === null && session.finishedAt !== null) {
          found = session;
          break;
        }
      }
    }

    const sets = (await this.db.sets.where('sessionId').equals(found.id).toArray())
      .filter(
        (row) =>
          row.exerciseId === exerciseId && row.deletedAt === null && isWorkingSet(row.setType),
      )
      .sort((a, b) => a.position - b.position || a.completedAt - b.completedAt);
    return { sessionId: found.id, finishedAt: found.finishedAt ?? found.startedAt, sets };
  }

  /** Exercícios que o dono pulou no treino aberto (só deste aparelho; não sobe para o servidor). */
  async skippedExercises(): Promise<string[]> {
    const active = await this.activeSession();
    if (!active) return [];
    const value = (await this.db.meta.get(META_SKIPPED))?.value as
      { sessionId: string; ids: string[] } | undefined;
    return value?.sessionId === active.id ? value.ids : [];
  }

  /** Pula (`true`) ou volta a incluir (`false`) um exercício no plano do treino aberto. */
  async setSkipped(exerciseId: string, skipped: boolean): Promise<void> {
    const active = await this.activeSession();
    if (!active) return;
    const current = new Set(await this.skippedExercises());
    if (skipped) current.add(exerciseId);
    else current.delete(exerciseId);
    await this.db.meta.put({
      key: META_SKIPPED,
      value: { sessionId: active.id, ids: [...current] },
    });
    this.touch();
  }

  /** Funde treinos que vieram do servidor. Nunca apaga linha por ausência; a lápide de um treino apaga as séries locais dele. */
  async applyRemoteSessions(remote: readonly LocalSession[]): Promise<void> {
    if (remote.length === 0) return;
    await this.db.transaction('rw', this.db.sessions, this.db.sets, async () => {
      const found = await this.db.sessions.bulkGet(remote.map((row) => row.id));
      const local = new Map<string, LocalSession>();
      for (const row of found) if (row) local.set(row.id, row);
      const writes = mergeById(local, remote, resolveSession);
      if (writes.length === 0) return;
      await this.db.sessions.bulkPut(writes);

      // O servidor propaga a lápide do treino às séries dele; o aparelho faz o mesmo sem esperar a leitura delas.
      for (const written of writes) {
        if (written.deletedAt === null) continue;
        const sets = await this.db.sets.where('sessionId').equals(written.id).toArray();
        const dead = sets
          .filter((set) => set.deletedAt === null)
          .map((set) => ({
            ...set,
            deletedAt: written.deletedAt,
            updatedAt: written.updatedAt,
            clientUpdatedAt: Math.max(set.clientUpdatedAt, written.clientUpdatedAt),
          }));
        if (dead.length > 0) await this.db.sets.bulkPut(dead);
      }
    });
    this.touch();
  }

  /** Funde séries que vieram do servidor. Nunca apaga linha por ausência. */
  async applyRemoteSets(remote: readonly LocalSet[]): Promise<void> {
    if (remote.length === 0) return;
    await this.db.transaction('rw', this.db.sets, async () => {
      const found = await this.db.sets.bulkGet(remote.map((row) => row.id));
      const local = new Map<string, LocalSet>();
      for (const row of found) if (row) local.set(row.id, row);
      const writes = mergeById(local, remote, resolveSet);
      if (writes.length > 0) await this.db.sets.bulkPut(writes);
    });
    this.touch();
  }

  /** Encerra uma sessão viva e aberta (a deste aparelho ou, em `closeElsewhere`, a de outro). */
  private async close(
    previous: LocalSession,
    options: { feeling?: number | null; note?: string },
    meta: MetaChange,
  ): Promise<SessionWriteResult> {
    const feeling = options.feeling === undefined ? previous.feeling : options.feeling;
    const note = (options.note ?? previous.note).trim();
    const issues = validateFinish(feeling, note);
    if (issues.length > 0) return { status: 'invalid', issues };

    const stamp = this.nextStamp(previous.clientUpdatedAt);
    const session: LocalSession = {
      ...previous,
      finishedAt: Math.max(this.runtime.now(), previous.startedAt),
      feeling,
      note,
      updatedAt: stamp,
      clientUpdatedAt: stamp,
    };
    const saved = await this.commit(
      [{ table: 'sessions', written: session, previous, enqueue: true }],
      meta,
    );
    return saved ? { status: 'saved', session } : { status: 'storage-full' };
  }

  /** Instante da escrita: o relógio do aparelho, nunca menor ou igual ao da escrita anterior da mesma linha. */
  private nextStamp(previous: number | undefined): number {
    return Math.max(this.runtime.now(), (previous ?? 0) + 1);
  }

  /**
   * Grava no banco local (e mexe no `meta`) numa transação e enfileira um `PUT` por escrita, na ordem dada. `false` = a
   * fila recusou por falta de espaço: o que já tinha entrado na fila é descartado e as gravações locais são desfeitas.
   */
  private async commit(writes: readonly PendingWrite[], meta: MetaChange = {}): Promise<boolean> {
    const metaKeys = [...Object.keys(meta.put ?? {}), ...(meta.remove ?? [])];
    const metaBefore = await this.db.meta.bulkGet(metaKeys);

    await this.db.transaction('rw', this.db.sessions, this.db.sets, this.db.meta, async () => {
      const sessions = writes
        .filter((w) => w.table === 'sessions')
        .map((w) => w.written as LocalSession);
      const sets = writes.filter((w) => w.table === 'sets').map((w) => w.written as LocalSet);
      if (sessions.length > 0) await this.db.sessions.bulkPut(sessions);
      if (sets.length > 0) await this.db.sets.bulkPut(sets);
      for (const [key, value] of Object.entries(meta.put ?? {}))
        await this.db.meta.put({ key, value });
      if (meta.remove?.length) await this.db.meta.bulkDelete([...meta.remove]);
    });
    this.touch();

    const queued: string[] = [];
    try {
      for (const write of writes) {
        if (!write.enqueue) continue;
        const request =
          write.table === 'sessions'
            ? {
                url: sessionPath(write.written.id),
                body: toSessionBody(write.written as LocalSession),
              }
            : {
                url: setPath((write.written as LocalSet).sessionId, write.written.id),
                body: toSetBody(write.written as LocalSet),
              };
        queued.push(await this.queue.enqueue({ method: 'PUT', module: QUEUE_MODULE, ...request }));
      }
      return true;
    } catch (error) {
      for (const key of queued) await this.queue.discard(key);
      await this.undo(writes, metaKeys, metaBefore);
      if (error instanceof QueueStorageFullError) return false;
      throw error;
    }
  }

  /** Desfaz as gravações locais que a fila recusou; só mexe na linha se ela ainda é a que foi gravada. */
  private async undo(
    writes: readonly PendingWrite[],
    metaKeys: readonly string[],
    metaBefore: readonly ({ key: string; value: unknown } | undefined)[],
  ): Promise<void> {
    await this.db.transaction('rw', this.db.sessions, this.db.sets, this.db.meta, async () => {
      for (const { table, written, previous } of writes) {
        if (table === 'sessions') {
          const current = await this.db.sessions.get(written.id);
          if (current === undefined || current.clientUpdatedAt !== written.clientUpdatedAt)
            continue;
          if (previous) await this.db.sessions.put(previous as LocalSession);
          else await this.db.sessions.delete(written.id);
        } else {
          const current = await this.db.sets.get(written.id);
          if (current === undefined || current.clientUpdatedAt !== written.clientUpdatedAt)
            continue;
          if (previous) await this.db.sets.put(previous as LocalSet);
          else await this.db.sets.delete(written.id);
        }
      }
      for (const [index, key] of metaKeys.entries()) {
        const before = metaBefore[index];
        if (before) await this.db.meta.put(before);
        else await this.db.meta.delete(key);
      }
    });
    this.touch();
  }

  private touch(): void {
    this._revision.update((value) => value + 1);
  }
}
