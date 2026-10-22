import type {
  LocalPhysicalAssessment,
  PhysicalAssessmentMeasure,
} from '../../data/physical-assessments/physical-assessment';

export const MEASURE_LABELS: Readonly<Record<string, string>> = {
  weight: $localize`:@@training.assessments.measure.weight:Peso`,
  height: $localize`:@@training.assessments.measure.height:Altura`,
  'body-fat': $localize`:@@training.assessments.measure.body-fat:Gordura corporal`,
  'lean-mass': $localize`:@@training.assessments.measure.lean-mass:Massa magra`,
  'fat-mass': $localize`:@@training.assessments.measure.fat-mass:Massa de gordura`,
  chest: $localize`:@@training.assessments.measure.chest:Tórax`,
  abdomen: $localize`:@@training.assessments.measure.abdomen:Abdome`,
  waist: $localize`:@@training.assessments.measure.waist:Cintura`,
  neck: $localize`:@@training.assessments.measure.neck:Pescoço`,
  hip: $localize`:@@training.assessments.measure.hip:Quadril`,
  'arm-relaxed': $localize`:@@training.assessments.measure.arm-relaxed:Braço relaxado`,
  'arm-contracted': $localize`:@@training.assessments.measure.arm-contracted:Braço contraído`,
  forearm: $localize`:@@training.assessments.measure.forearm:Antebraço`,
  thigh: $localize`:@@training.assessments.measure.thigh:Coxa`,
  calf: $localize`:@@training.assessments.measure.calf:Panturrilha`,
  'skinfold-chest': $localize`:@@training.assessments.measure.skinfold-chest:Dobra peitoral`,
  'skinfold-abdominal': $localize`:@@training.assessments.measure.skinfold-abdominal:Dobra abdominal`,
  'skinfold-thigh': $localize`:@@training.assessments.measure.skinfold-thigh:Dobra da coxa`,
  'skinfold-triceps': $localize`:@@training.assessments.measure.skinfold-triceps:Dobra do tríceps`,
  'skinfold-suprailiac': $localize`:@@training.assessments.measure.skinfold-suprailiac:Dobra supra-ilíaca`,
  'body-density': $localize`:@@training.assessments.measure.body-density:Densidade corporal`,
  'pollock-3-body-fat': $localize`:@@training.assessments.measure.pollock-3:Percentual calculado · Pollock 3`,
};

export const KIND_LABELS = {
  measured: $localize`:@@training.assessments.kind.measured:Medido`,
  calculated: $localize`:@@training.assessments.kind.calculated:Calculado pela origem`,
  reference: $localize`:@@training.assessments.kind.reference:Referência sugerida`,
} as const;

export function measureLabel(type: string): string {
  return MEASURE_LABELS[type] ?? type;
}

export function measurementText(measure: PhysicalAssessmentMeasure): string {
  return `${measure.reportedValue} ${measure.unit}`.trim();
}

export function assessmentTitle(assessment: LocalPhysicalAssessment): string {
  return new Intl.DateTimeFormat('pt-BR', {
    day: '2-digit',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${assessment.assessedOn}T00:00:00Z`));
}
