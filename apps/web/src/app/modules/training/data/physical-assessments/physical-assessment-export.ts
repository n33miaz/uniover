import { Injectable, inject } from '@angular/core';
import { QUEUE_RUNTIME } from '../../../../core/offline-queue/queue-ports';
import { TRAINING_DB } from '../training-db';

function base64(data: ArrayBuffer): string {
  const bytes = new Uint8Array(data);
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

/** Cópia privada sob demanda de UMA avaliação. Nunca entra na exportação comum do Treino nem em URL pública. */
@Injectable()
export class PhysicalAssessmentExport {
  private readonly db = inject(TRAINING_DB);
  private readonly runtime = inject(QUEUE_RUNTIME);

  /** Produz um documento sensível apenas quando a tela chama explicitamente esta operação para uma avaliação. */
  async build(id: string): Promise<unknown | null> {
    const assessment = await this.db.physicalAssessments.get(id);
    if (assessment === undefined) return null;
    const documents = await this.db.assessmentDocuments.where('assessmentId').equals(id).toArray();
    return {
      app: 'uniover',
      module: 'training',
      exportType: 'physical-assessment',
      exportVersion: 1,
      exportedAt: new Date(this.runtime.now()).toISOString(),
      assessment: {
        id: assessment.id,
        assessedOn: assessment.assessedOn,
        origin: assessment.origin ?? null,
        professional: assessment.professional ?? null,
        reportedAgeYears: assessment.reportedAgeYears ?? null,
        statedGoal: assessment.statedGoal ?? null,
        activityStatus: assessment.activityStatus ?? null,
        plannedFrequencyPerWeek: assessment.plannedFrequencyPerWeek ?? null,
        notes: assessment.notes ?? null,
        measurements: assessment.measurements ?? [],
        createdAt: new Date(assessment.createdAt).toISOString(),
        updatedAt: new Date(assessment.updatedAt).toISOString(),
        documents: documents
          .sort((a, b) => a.addedAt - b.addedAt)
          .map((document) => ({
            id: document.id,
            name: document.name,
            mediaType: document.mediaType,
            bytes: document.bytes,
            addedAt: new Date(document.addedAt).toISOString(),
            dataBase64: base64(document.data),
          })),
      },
    };
  }
}
