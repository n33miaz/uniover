/** Medida de uma avaliação física. `reportedValue` preserva o conteúdo como recebido, inclusive texto como `00`. */
export interface PhysicalAssessmentMeasure {
  readonly type: PhysicalAssessmentMeasureType;
  readonly reportedValue: number | string;
  readonly unit: string;
  readonly kind: 'measured' | 'calculated' | 'reference';
  readonly side?: 'left' | 'right' | null;
  readonly method?: string | null;
  /** Procedência específica do campo, quando difere da origem do relatório. */
  readonly source?: string | null;
}

/** Campos conhecidos; o formato também aceita nomes futuros para não perder informação de um relatório novo. */
export type PhysicalAssessmentMeasureType =
  | 'weight'
  | 'height'
  | 'body-fat'
  | 'lean-mass'
  | 'fat-mass'
  | 'chest'
  | 'abdomen'
  | 'waist'
  | 'neck'
  | 'hip'
  | 'arm-relaxed'
  | 'arm-contracted'
  | 'forearm'
  | 'thigh'
  | 'calf'
  | 'skinfold-chest'
  | 'skinfold-abdominal'
  | 'skinfold-thigh'
  | 'skinfold-triceps'
  | 'skinfold-suprailiac'
  | 'body-density'
  | 'pollock-3-body-fat'
  | (string & {});

/** Uma avaliação histórica. Não há campos obrigatórios de medida: relatório parcial continua representável. */
export interface LocalPhysicalAssessment {
  readonly id: string;
  /** Dia local reportado, no formato `AAAA-MM-DD`. */
  readonly assessedOn: string;
  readonly origin?: string | null;
  readonly professional?: string | null;
  /** Contexto declarado no relatório, nunca inferido do perfil ou de um plano de treino. */
  readonly reportedAgeYears?: number | null;
  readonly statedGoal?: string | null;
  readonly activityStatus?: string | null;
  readonly plannedFrequencyPerWeek?: number | null;
  readonly notes?: string | null;
  readonly measurements?: readonly PhysicalAssessmentMeasure[];
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** Imagem de documento de uma avaliação. Armazenada separadamente de `photos` e nunca sincronizada. */
export interface LocalAssessmentDocument {
  readonly id: string;
  readonly assessmentId: string;
  readonly name: string;
  readonly mediaType: string;
  readonly data: ArrayBuffer;
  readonly bytes: number;
  readonly addedAt: number;
}

export type AssessmentDocumentInfo = Omit<LocalAssessmentDocument, 'data'>;
