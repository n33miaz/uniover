import { Injectable, inject, signal } from '@angular/core';
import { OfflineQueue } from '../../../../core/offline-queue/offline-queue';
import { QueueStorageFullError } from '../../../../core/offline-queue/outbox-store';
import { QUEUE_RUNTIME } from '../../../../core/offline-queue/queue-ports';
import { uuidV7 } from '../../../../core/offline-queue/uuid-v7';
import {
  BODY_LIMITS,
  type BodyEntryIssue,
  type BodyEntryValues,
  type FatMethod,
  validateBodyEntry,
} from '../../domain/body/body-limits';
import { addDaysToKey } from '../../domain/body/date-key';
import type { WeightSample } from '../../domain/body/weight-trend';
import { dateKey, deviceTimeZone } from '../../domain/progress/calendar';
import { mergeById } from '../sync/merge';
import { TRAINING_DB } from '../training-db';
import { type LocalBodyEntry, asTombstone, resolveBodyEntry, toBodyEntryBody } from './body-entry';
import { bodyEntryPath } from './body-api';

/**
 * O que a tela entrega ao salvar uma medição. Todo valor é opcional (a medição precisa de pelo menos um); a data padrão é o
 * dia de hoje do aparelho.
 */
export interface BodyEntryDraft {
  /** Dia local `AAAA-MM-DD`. */
  readonly measuredOn?: string;
  readonly weightKg?: number | null;
  readonly bodyFatPct?: number | null;
  /** Obrigatório junto do percentual de gordura (de onde ele veio). */
  readonly fatMethod?: FatMethod | null;
  readonly waistCm?: number | null;
  readonly neckCm?: number | null;
  readonly hipCm?: number | null;
  readonly armCm?: number | null;
  readonly thighCm?: number | null;
  readonly chestCm?: number | null;
  readonly abdomenCm?: number | null;
  readonly forearmCm?: number | null;
  readonly calfCm?: number | null;
  readonly armRightCm?: number | null;
  readonly armLeftCm?: number | null;
  readonly forearmRightCm?: number | null;
  readonly forearmLeftCm?: number | null;
  readonly thighRightCm?: number | null;
  readonly thighLeftCm?: number | null;
  readonly calfRightCm?: number | null;
  readonly calfLeftCm?: number | null;
  readonly chestSkinfoldMm?: number | null;
  readonly abdomenSkinfoldMm?: number | null;
  readonly thighSkinfoldMm?: number | null;
  readonly note?: string;
}

/**
 * Resultado de uma escrita de medição. `invalid`: a medição não passa nos limites (`issues` diz o campo). `not-found`: não
 * há medição viva com esse id. `storage-full`: o aparelho não tem espaço para guardar o pedido, e nada ficou gravado.
 */
export type BodyWriteResult =
  | { readonly status: 'saved'; readonly entry: LocalBodyEntry }
  | { readonly status: 'invalid'; readonly issues: readonly BodyEntryIssue[] }
  | { readonly status: 'not-found' }
  | { readonly status: 'storage-full' };

/** Um período em dias locais (`AAAA-MM-DD`), limites incluídos; o que falta fica aberto. */
export interface BodyPeriod {
  readonly from?: string;
  readonly to?: string;
}

/** A última medida de um tipo, com a data em que foi feita ("cintura 86,0 cm · 11/10"). */
export interface LatestMeasure {
  readonly value: number;
  readonly measuredOn: string;
}

/** A última medida de cada tipo (só os tipos que o dono já mediu aparecem). */
export interface LatestMeasurements {
  readonly weightKg?: LatestMeasure;
  /** Com o método de onde veio o percentual. */
  readonly bodyFatPct?: LatestMeasure & { readonly fatMethod: FatMethod | null };
  readonly waistCm?: LatestMeasure;
  readonly neckCm?: LatestMeasure;
  readonly hipCm?: LatestMeasure;
  readonly armCm?: LatestMeasure;
  readonly thighCm?: LatestMeasure;
  readonly chestCm?: LatestMeasure;
  readonly abdomenCm?: LatestMeasure;
  readonly forearmCm?: LatestMeasure;
  readonly calfCm?: LatestMeasure;
  readonly armRightCm?: LatestMeasure;
  readonly armLeftCm?: LatestMeasure;
  readonly forearmRightCm?: LatestMeasure;
  readonly forearmLeftCm?: LatestMeasure;
  readonly thighRightCm?: LatestMeasure;
  readonly thighLeftCm?: LatestMeasure;
  readonly calfRightCm?: LatestMeasure;
  readonly calfLeftCm?: LatestMeasure;
  readonly chestSkinfoldMm?: LatestMeasure;
  readonly abdomenSkinfoldMm?: LatestMeasure;
  readonly thighSkinfoldMm?: LatestMeasure;
}

const QUEUE_MODULE = 'training';
/** Fim aberto do intervalo por data (texto): maior que qualquer data aceita. */
const LAST_DATE_KEY = '9999-12-31';

const MEASURE_KEYS = [
  'weightKg',
  'bodyFatPct',
  'waistCm',
  'neckCm',
  'hipCm',
  'armCm',
  'thighCm',
  'chestCm',
  'abdomenCm',
  'forearmCm',
  'calfCm',
  'armRightCm',
  'armLeftCm',
  'forearmRightCm',
  'forearmLeftCm',
  'thighRightCm',
  'thighLeftCm',
  'calfRightCm',
  'calfLeftCm',
  'chestSkinfoldMm',
  'abdomenSkinfoldMm',
  'thighSkinfoldMm',
] as const;

/**
 * Único ponto de acesso às medições do corpo. A tela lê daqui, sempre do banco local e sem rede, e nunca vê lápide.
 *
 * Escrever = gravar no banco local **e** enfileirar **um** `PUT` (a medição inteira). Se a fila recusar por falta de
 * espaço, a gravação local é desfeita: nada fica pela metade. Apagar é um `PUT` com lápide, nunca um `DELETE`. O servidor
 * não calcula nada de saúde: guarda o que o aparelho calculou, com o método da gordura. **Dado de saúde nunca vai para log**
 * (nem valor, nem nome de campo com valor). As fotos de progresso NÃO passam por aqui: são só do aparelho (`PhotoStore`).
 */
@Injectable()
export class BodyRepository {
  private readonly db = inject(TRAINING_DB);
  private readonly queue = inject(OfflineQueue);
  private readonly runtime = inject(QUEUE_RUNTIME);
  private readonly _revision = signal(0);

  /** Sobe a cada gravação neste aparelho; quem mostra a tela relê quando muda. */
  readonly revision = this._revision.asReadonly();

  /** O dia de hoje do aparelho, `AAAA-MM-DD`. */
  today(): string {
    return dateKey(this.runtime.now(), deviceTimeZone());
  }

  /** A medição viva com o id, ou `undefined`. */
  async get(id: string): Promise<LocalBodyEntry | undefined> {
    const row = await this.db.bodyEntries.get(id);
    return row !== undefined && row.deletedAt === null ? row : undefined;
  }

  /**
   * As medições vivas do período, em ordem cronológica (a mais antiga primeiro; no mesmo dia, a gravada antes primeiro).
   * Sem período, todas.
   */
  async entries(period: BodyPeriod = {}): Promise<LocalBodyEntry[]> {
    const from = period.from ?? BODY_LIMITS.earliestDate;
    const to = period.to ?? LAST_DATE_KEY;
    if (from > to) return [];
    const rows = await this.db.bodyEntries
      .where('measuredOn')
      .between(from, to, true, true)
      .toArray();
    return rows
      .filter((row) => row.deletedAt === null)
      .sort(
        (a, b) =>
          a.measuredOn.localeCompare(b.measuredOn) ||
          a.clientUpdatedAt - b.clientUpdatedAt ||
          // Mesmo dia e mesmo instante (relógio parado): o id v7 ordena pela criação.
          a.id.localeCompare(b.id),
      );
  }

  /** O que a tendência de peso precisa: o peso de cada medição que tem peso, com a ordem de gravação. */
  async weightSamples(period: BodyPeriod = {}): Promise<WeightSample[]> {
    return (await this.entries(period)).map((row) => ({
      date: row.measuredOn,
      weightKg: row.weightKg,
      order: row.clientUpdatedAt,
    }));
  }

  /**
   * A última medida de cada tipo, com a data ("cintura 86,0 cm · 11/10"): a mais recente medição que tem aquele valor, e
   * no mesmo dia a gravada por último.
   */
  async latestMeasurements(): Promise<LatestMeasurements> {
    const newestFirst = [...(await this.entries())].reverse();
    const found: { -readonly [K in keyof LatestMeasurements]: LatestMeasurements[K] } = {};
    for (const key of MEASURE_KEYS) {
      const row = newestFirst.find((candidate) => candidate[key] != null);
      if (row === undefined) continue;
      const measure = { value: row[key] as number, measuredOn: row.measuredOn };
      if (key === 'bodyFatPct') found.bodyFatPct = { ...measure, fatMethod: row.fatMethod };
      else found[key] = measure;
    }
    return found;
  }

  /**
   * Grava uma medição nova (ou, com `id`, troca por inteiro a que já existe) e enfileira o `PUT`. Valida com os mesmos
   * limites da API: o que ela recusaria nem entra na fila.
   */
  async saveEntry(draft: BodyEntryDraft, id?: string): Promise<BodyWriteResult> {
    const previous = id === undefined ? undefined : await this.db.bodyEntries.get(id);
    if (id !== undefined && (previous === undefined || previous.deletedAt !== null)) {
      return { status: 'not-found' };
    }

    const values: BodyEntryValues = {
      weightKg: draft.weightKg ?? null,
      bodyFatPct: draft.bodyFatPct ?? null,
      fatMethod: draft.fatMethod ?? null,
      waistCm: draft.waistCm ?? null,
      neckCm: draft.neckCm ?? null,
      hipCm: draft.hipCm ?? null,
      armCm: draft.armCm ?? null,
      thighCm: draft.thighCm ?? null,
      chestCm: draft.chestCm ?? null,
      abdomenCm: draft.abdomenCm ?? null,
      forearmCm: draft.forearmCm ?? null,
      calfCm: draft.calfCm ?? null,
      armRightCm: draft.armRightCm ?? null,
      armLeftCm: draft.armLeftCm ?? null,
      forearmRightCm: draft.forearmRightCm ?? null,
      forearmLeftCm: draft.forearmLeftCm ?? null,
      thighRightCm: draft.thighRightCm ?? null,
      thighLeftCm: draft.thighLeftCm ?? null,
      calfRightCm: draft.calfRightCm ?? null,
      calfLeftCm: draft.calfLeftCm ?? null,
      chestSkinfoldMm: draft.chestSkinfoldMm ?? null,
      abdomenSkinfoldMm: draft.abdomenSkinfoldMm ?? null,
      thighSkinfoldMm: draft.thighSkinfoldMm ?? null,
      note: draft.note ?? '',
    };
    const measuredOn = draft.measuredOn ?? previous?.measuredOn ?? this.today();
    // A API aceita até um dia à frente da data dela (o fuso do aparelho pode estar adiantado): a mesma folga vale aqui.
    const latestAllowed = addDaysToKey(this.today(), 1) as string;
    const issues = validateBodyEntry(measuredOn, values, latestAllowed);
    if (issues.length > 0) return { status: 'invalid', issues };

    const stamp = this.nextStamp(previous?.clientUpdatedAt);
    const written: LocalBodyEntry = {
      id: id ?? uuidV7(),
      measuredOn,
      ...values,
      note: values.note.trim(),
      updatedAt: stamp,
      clientUpdatedAt: stamp,
      deletedAt: null,
    };
    return this.commit(written, previous);
  }

  /** Apaga a medição por lápide (os valores se esvaziam e o `PUT` leva a lápide), nunca por `DELETE`. */
  async softDeleteEntry(id: string): Promise<BodyWriteResult> {
    const previous = await this.db.bodyEntries.get(id);
    if (previous === undefined || previous.deletedAt !== null) return { status: 'not-found' };

    const written = asTombstone(previous, this.nextStamp(previous.clientUpdatedAt));
    return this.commit(written, previous);
  }

  /** Funde medições que vieram do servidor. Nunca apaga linha por ausência; a lápide chega como linha. */
  async applyRemote(remote: readonly LocalBodyEntry[]): Promise<void> {
    if (remote.length === 0) return;
    await this.db.transaction('rw', this.db.bodyEntries, async () => {
      const found = await this.db.bodyEntries.bulkGet(remote.map((row) => row.id));
      const local = new Map<string, LocalBodyEntry>();
      for (const row of found) if (row) local.set(row.id, row);
      const writes = mergeById(local, remote, resolveBodyEntry);
      if (writes.length > 0) await this.db.bodyEntries.bulkPut(writes);
    });
    this.touch();
  }

  /** Instante da escrita: o relógio do aparelho, nunca menor ou igual ao da escrita anterior da mesma medição. */
  private nextStamp(previous: number | undefined): number {
    return Math.max(this.runtime.now(), (previous ?? 0) + 1);
  }

  /** Grava no banco local e enfileira o `PUT`; se a fila recusar por falta de espaço, desfaz a gravação local. */
  private async commit(
    written: LocalBodyEntry,
    previous: LocalBodyEntry | undefined,
  ): Promise<BodyWriteResult> {
    await this.db.bodyEntries.put(written);
    this.touch();
    try {
      await this.queue.enqueue({
        method: 'PUT',
        module: QUEUE_MODULE,
        url: bodyEntryPath(written.id),
        body: toBodyEntryBody(written),
      });
      return { status: 'saved', entry: written };
    } catch (error) {
      await this.undo(written, previous);
      if (error instanceof QueueStorageFullError) return { status: 'storage-full' };
      throw error;
    }
  }

  /** Desfaz a gravação local que a fila recusou; só mexe na linha se ela ainda é a que foi gravada. */
  private async undo(written: LocalBodyEntry, previous: LocalBodyEntry | undefined): Promise<void> {
    await this.db.transaction('rw', this.db.bodyEntries, async () => {
      const current = await this.db.bodyEntries.get(written.id);
      if (current === undefined || current.clientUpdatedAt !== written.clientUpdatedAt) return;
      if (previous) await this.db.bodyEntries.put(previous);
      else await this.db.bodyEntries.delete(written.id);
    });
    this.touch();
  }

  private touch(): void {
    this._revision.update((value) => value + 1);
  }
}
