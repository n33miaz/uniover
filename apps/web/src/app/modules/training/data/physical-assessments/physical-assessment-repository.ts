import { Injectable, inject, signal } from '@angular/core';
import { QUEUE_RUNTIME } from '../../../../core/offline-queue/queue-ports';
import { uuidV7 } from '../../../../core/offline-queue/uuid-v7';
import { TRAINING_DB } from '../training-db';
import type {
  AssessmentDocumentInfo,
  LocalAssessmentDocument,
  LocalPhysicalAssessment,
} from './physical-assessment';

export const ASSESSMENT_DOCUMENT_MAX_BYTES = 12 * 1024 * 1024;
export const ASSESSMENT_DOCUMENTS_MAX_BYTES = 30 * 1024 * 1024;
const ALLOWED_DOCUMENT_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
]);

export interface PhysicalAssessmentDraft {
  readonly assessedOn: string;
  readonly origin?: string | null;
  readonly professional?: string | null;
  readonly reportedAgeYears?: number | null;
  readonly statedGoal?: string | null;
  readonly activityStatus?: string | null;
  readonly plannedFrequencyPerWeek?: number | null;
  readonly notes?: string | null;
  readonly measurements?: LocalPhysicalAssessment['measurements'];
}

export type AssessmentDocumentAddResult =
  | { readonly status: 'saved'; readonly document: AssessmentDocumentInfo }
  | { readonly status: 'not-found' | 'invalid-type' | 'too-large' | 'storage-full' };

function isQuotaError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { name?: unknown; inner?: unknown; cause?: unknown };
  return (
    candidate.name === 'QuotaExceededError' ||
    (candidate.inner !== undefined && candidate.inner !== error && isQuotaError(candidate.inner)) ||
    (candidate.cause !== undefined && candidate.cause !== error && isQuotaError(candidate.cause))
  );
}

/** Histórico privado no IndexedDB da conta ativa. Não acessa fila, rede ou telemetria. */
@Injectable()
export class PhysicalAssessmentRepository {
  private readonly db = inject(TRAINING_DB);
  private readonly runtime = inject(QUEUE_RUNTIME);
  private readonly _revision = signal(0);
  readonly revision = this._revision.asReadonly();

  async list(): Promise<LocalPhysicalAssessment[]> {
    return (await this.db.physicalAssessments.orderBy('assessedOn').toArray()).sort(
      (a, b) =>
        a.assessedOn.localeCompare(b.assessedOn) ||
        a.createdAt - b.createdAt ||
        a.id.localeCompare(b.id),
    );
  }

  get(id: string): Promise<LocalPhysicalAssessment | undefined> {
    return this.db.physicalAssessments.get(id);
  }

  /** Cria uma versão histórica ou substitui explicitamente o id recebido. */
  async save(draft: PhysicalAssessmentDraft, id?: string): Promise<LocalPhysicalAssessment> {
    const previous = id === undefined ? undefined : await this.db.physicalAssessments.get(id);
    if (id !== undefined && previous === undefined) throw new Error('Avaliação não encontrada.');
    const now = this.runtime.now();
    const row: LocalPhysicalAssessment = {
      id: previous?.id ?? uuidV7(),
      assessedOn: draft.assessedOn,
      origin: draft.origin ?? null,
      professional: draft.professional ?? null,
      reportedAgeYears: draft.reportedAgeYears ?? null,
      statedGoal: draft.statedGoal ?? null,
      activityStatus: draft.activityStatus ?? null,
      plannedFrequencyPerWeek: draft.plannedFrequencyPerWeek ?? null,
      notes: draft.notes ?? null,
      measurements: draft.measurements ?? [],
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
    };
    await this.db.physicalAssessments.put(row);
    this.touch();
    return row;
  }

  /** Apaga o registro e todos os documentos numa única transação local. */
  async delete(id: string): Promise<boolean> {
    const existed = await this.db.physicalAssessments.get(id);
    if (existed === undefined) return false;
    await this.db.transaction(
      'rw',
      this.db.physicalAssessments,
      this.db.assessmentDocuments,
      async () => {
        await this.db.assessmentDocuments.where('assessmentId').equals(id).delete();
        await this.db.physicalAssessments.delete(id);
      },
    );
    this.touch();
    return true;
  }

  /** Guarda o arquivo original de imagem somente neste aparelho, sem usar a tabela de fotos de progresso. */
  async addDocument(
    assessmentId: string,
    file: Blob,
    name = 'documento',
  ): Promise<AssessmentDocumentAddResult> {
    if ((await this.get(assessmentId)) === undefined) return { status: 'not-found' };
    if (!ALLOWED_DOCUMENT_TYPES.has(file.type.toLowerCase())) return { status: 'invalid-type' };
    if (file.size > ASSESSMENT_DOCUMENT_MAX_BYTES) return { status: 'too-large' };
    const data = await file.arrayBuffer();
    const row: LocalAssessmentDocument = {
      id: uuidV7(),
      assessmentId,
      name,
      mediaType: file.type,
      data,
      bytes: data.byteLength,
      addedAt: this.runtime.now(),
    };
    try {
      const status = await this.db.transaction(
        'rw',
        this.db.physicalAssessments,
        this.db.assessmentDocuments,
        async () => {
          if ((await this.db.physicalAssessments.get(assessmentId)) === undefined)
            return 'not-found' as const;
          const existing = await this.db.assessmentDocuments
            .where('assessmentId')
            .equals(assessmentId)
            .toArray();
          const existingBytes = existing.reduce((sum, item) => sum + item.bytes, 0);
          if (existingBytes + row.bytes > ASSESSMENT_DOCUMENTS_MAX_BYTES)
            return 'too-large' as const;
          await this.db.assessmentDocuments.add(row);
          return 'saved' as const;
        },
      );
      if (status === 'too-large') return { status };
      if (status === 'not-found') return { status };
    } catch (error) {
      if (isQuotaError(error)) return { status: 'storage-full' };
      throw error;
    }
    this.touch();
    return { status: 'saved', document: this.documentInfo(row) };
  }

  async documents(assessmentId: string): Promise<AssessmentDocumentInfo[]> {
    return (await this.db.assessmentDocuments.where('assessmentId').equals(assessmentId).toArray())
      .sort((a, b) => a.addedAt - b.addedAt)
      .map((row) => this.documentInfo(row));
  }

  /** Bytes acessíveis apenas pela tela de documento; a listagem nunca os retorna. */
  async documentData(id: string): Promise<ArrayBuffer | null> {
    return (await this.db.assessmentDocuments.get(id))?.data ?? null;
  }

  async removeDocument(id: string): Promise<boolean> {
    const existed = (await this.db.assessmentDocuments.get(id)) !== undefined;
    if (!existed) return false;
    await this.db.assessmentDocuments.delete(id);
    this.touch();
    return true;
  }

  private documentInfo(row: LocalAssessmentDocument): AssessmentDocumentInfo {
    return {
      id: row.id,
      assessmentId: row.assessmentId,
      name: row.name,
      mediaType: row.mediaType,
      bytes: row.bytes,
      addedAt: row.addedAt,
    };
  }

  private touch(): void {
    this._revision.update((value) => value + 1);
  }
}
