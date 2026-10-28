import type {
  LocalPhysicalAssessment,
  PhysicalAssessmentMeasure,
} from '../../data/physical-assessments/physical-assessment';
import type { BodyEntryDraft } from '../../data/body/body-repository';
import type { LocalBodyEntry } from '../../data/body/body-entry';
import { BODY_LIMITS } from '../../domain/body/body-limits';

export type AssessmentBodyField =
  | 'weightKg'
  | 'bodyFatPct'
  | 'waistCm'
  | 'neckCm'
  | 'hipCm'
  | 'thighCm'
  | 'chestCm'
  | 'abdomenCm'
  | 'forearmRightCm'
  | 'forearmLeftCm'
  | 'calfRightCm'
  | 'calfLeftCm'
  | 'armRightCm'
  | 'armLeftCm'
  | 'thighRightCm'
  | 'thighLeftCm'
  | 'chestSkinfoldMm'
  | 'abdomenSkinfoldMm'
  | 'thighSkinfoldMm';

export function assessmentBodyTransferKey(fingerprint: string, field: AssessmentBodyField): string {
  return `assessment-body-transfer:${fingerprint}:${field}`;
}

export interface AssessmentBodyCandidate {
  readonly key: string;
  readonly field: AssessmentBodyField;
  readonly value: number;
  readonly unit: string;
  readonly measure: PhysicalAssessmentMeasure;
}

const fieldLimits: Readonly<
  Record<AssessmentBodyField, { min: number; max: number; decimals: number }>
> = {
  weightKg: BODY_LIMITS.weightKg,
  bodyFatPct: BODY_LIMITS.bodyFatPct,
  waistCm: BODY_LIMITS.circumferenceCm,
  neckCm: BODY_LIMITS.circumferenceCm,
  hipCm: BODY_LIMITS.circumferenceCm,
  thighCm: BODY_LIMITS.circumferenceCm,
  chestCm: BODY_LIMITS.circumferenceCm,
  abdomenCm: BODY_LIMITS.circumferenceCm,
  forearmRightCm: BODY_LIMITS.circumferenceCm,
  forearmLeftCm: BODY_LIMITS.circumferenceCm,
  calfRightCm: BODY_LIMITS.circumferenceCm,
  calfLeftCm: BODY_LIMITS.circumferenceCm,
  armRightCm: BODY_LIMITS.circumferenceCm,
  armLeftCm: BODY_LIMITS.circumferenceCm,
  thighRightCm: BODY_LIMITS.circumferenceCm,
  thighLeftCm: BODY_LIMITS.circumferenceCm,
  chestSkinfoldMm: BODY_LIMITS.skinfoldMm,
  abdomenSkinfoldMm: BODY_LIMITS.skinfoldMm,
  thighSkinfoldMm: BODY_LIMITS.skinfoldMm,
};

function parseReportedNumber(value: number | string): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const text = value.trim();
  if (!/^[+-]?(?:\d+(?:[.,]\d*)?|[.,]\d+)$/.test(text)) return null;
  const number = Number(text.replace(',', '.'));
  return Number.isFinite(number) ? number : null;
}

function bodyField(measure: PhysicalAssessmentMeasure): AssessmentBodyField | null {
  const unit = measure.unit.trim().toLocaleLowerCase('pt-BR');
  switch (measure.type) {
    case 'weight':
      return unit === 'kg' ? 'weightKg' : null;
    case 'body-fat':
      return unit === '%' ? 'bodyFatPct' : null;
    case 'waist':
      return unit === 'cm' ? 'waistCm' : null;
    case 'neck':
      return unit === 'cm' ? 'neckCm' : null;
    case 'hip':
      return unit === 'cm' ? 'hipCm' : null;
    case 'thigh':
      return unit === 'cm'
        ? measure.side === 'right'
          ? 'thighRightCm'
          : measure.side === 'left'
            ? 'thighLeftCm'
            : 'thighCm'
        : null;
    case 'chest':
      return !measure.side && unit === 'cm' ? 'chestCm' : null;
    case 'abdomen':
      return !measure.side && unit === 'cm' ? 'abdomenCm' : null;
    case 'arm-contracted':
      return unit === 'cm' ? sideField('arm', measure.side) : null;
    case 'forearm':
      return unit === 'cm' ? sideField('forearm', measure.side) : null;
    case 'calf':
      return unit === 'cm' ? sideField('calf', measure.side) : null;
    case 'skinfold-chest':
      return !measure.side && unit === 'mm' ? 'chestSkinfoldMm' : null;
    case 'skinfold-abdominal':
      return !measure.side && unit === 'mm' ? 'abdomenSkinfoldMm' : null;
    case 'skinfold-thigh':
      return !measure.side && unit === 'mm' ? 'thighSkinfoldMm' : null;
    default:
      return null;
  }
}

function sideField(
  prefix: 'arm' | 'forearm' | 'calf',
  side: PhysicalAssessmentMeasure['side'],
): AssessmentBodyField | null {
  if (side === 'right') return `${prefix}RightCm` as AssessmentBodyField;
  if (side === 'left') return `${prefix}LeftCm` as AssessmentBodyField;
  return null;
}

function validMethod(measure: PhysicalAssessmentMeasure): boolean {
  if (measure.type !== 'body-fat') return true;
  if (measure.kind === 'measured') return true;
  const method = measure.method?.trim().toLocaleLowerCase('pt-BR');
  return measure.kind === 'calculated' && (method === 'marinha' || method === 'navy');
}

/** Retorna apenas valores medidos e sem ambiguidade de unidade, lado ou campo no Corpo. */
export function assessmentBodyCandidates(
  assessment: LocalPhysicalAssessment,
): AssessmentBodyCandidate[] {
  const raw: AssessmentBodyCandidate[] = [];
  for (const [index, measure] of (assessment.measurements ?? []).entries()) {
    if (measure.kind === 'reference' || !validMethod(measure)) continue;
    const field = bodyField(measure);
    const value = parseReportedNumber(measure.reportedValue);
    if (field === null || value === null) continue;
    const { min, max } = fieldLimits[field];
    const scaled = value * 10 ** fieldLimits[field].decimals;
    if (value < min || value > max || Math.abs(scaled - Math.round(scaled)) >= 1e-6) continue;
    raw.push({ key: `measurement-${index}`, field, value, unit: measure.unit, measure });
  }

  const counts = new Map<AssessmentBodyField, number>();
  for (const candidate of raw) counts.set(candidate.field, (counts.get(candidate.field) ?? 0) + 1);
  return raw.filter((candidate) => counts.get(candidate.field) === 1);
}

/** Constrói a medição do Corpo sem arredondar o valor informado no relatório. */
export function assessmentBodyDraft(
  assessment: LocalPhysicalAssessment,
  selected: readonly AssessmentBodyCandidate[],
): BodyEntryDraft {
  const note = assessmentBodyNote(assessment, selected);
  const draft: BodyEntryDraft = { measuredOn: assessment.assessedOn, note };
  for (const candidate of selected) {
    switch (candidate.field) {
      case 'weightKg':
        Object.assign(draft, { weightKg: candidate.value });
        break;
      case 'bodyFatPct':
        Object.assign(draft, {
          bodyFatPct: candidate.value,
          fatMethod: fatMethod(candidate.measure),
        });
        break;
      case 'waistCm':
        Object.assign(draft, { waistCm: candidate.value });
        break;
      case 'neckCm':
        Object.assign(draft, { neckCm: candidate.value });
        break;
      case 'hipCm':
        Object.assign(draft, { hipCm: candidate.value });
        break;
      case 'thighCm':
        Object.assign(draft, { thighCm: candidate.value });
        break;
      default:
        Object.assign(draft, { [candidate.field]: candidate.value });
        break;
    }
  }
  return draft;
}

/** Anotação persistida no Corpo, incluindo o marcador técnico dos campos selecionados. */
export function assessmentBodyNote(
  assessment: LocalPhysicalAssessment,
  selected: readonly AssessmentBodyCandidate[],
): string {
  const fields = [...new Set(selected.map(({ field }) => field))].sort();
  return `${assessmentBodyProvenance(assessment, selected)} [assessment-fields:${fields.join(',')}]`;
}

export function assessmentBodyNoteTooLong(
  assessment: LocalPhysicalAssessment,
  selected: readonly AssessmentBodyCandidate[],
): boolean {
  return assessmentBodyNote(assessment, selected).length > BODY_LIMITS.noteMax;
}

/** Recupera campos efetivamente presentes no Corpo, sem assumir que uma anotação cobre todos os candidatos. */
export function assessmentBodyTransferredFields(
  assessment: LocalPhysicalAssessment,
  candidates: readonly AssessmentBodyCandidate[],
  entries: readonly LocalBodyEntry[],
): AssessmentBodyField[] {
  const transferred = new Set<AssessmentBodyField>();
  for (const entry of entries) {
    const ownAssessment = entry.note.includes(`[assessment:${assessment.id}]`);
    if (!ownAssessment) continue;
    const explicitFields = entry.note.match(/\[assessment-fields:([a-zA-Z0-9_,]+)\]/)?.[1];
    for (const candidate of candidates) {
      if (explicitFields !== undefined && !explicitFields.split(',').includes(candidate.field))
        continue;
      if (assessmentBodyEntryMatchesField(assessment, candidate, entry))
        transferred.add(candidate.field);
    }
  }
  return [...transferred];
}

export function assessmentBodyEntryMatchesField(
  assessment: LocalPhysicalAssessment,
  candidate: AssessmentBodyCandidate,
  entry: LocalBodyEntry,
): boolean {
  if (entry.measuredOn !== assessment.assessedOn) return false;
  const expected = assessmentBodyDraft(assessment, [candidate]);
  if (entry[candidate.field] !== expected[candidate.field]) return false;
  return candidate.field !== 'bodyFatPct' || entry.fatMethod === expected.fatMethod;
}

export function assessmentBodyProvenance(
  assessment: LocalPhysicalAssessment,
  selected: readonly AssessmentBodyCandidate[],
): string {
  const methods = [
    ...new Set(selected.map(({ measure }) => safeMethod(measure.method)).filter(Boolean)),
  ];
  const fieldNames: Readonly<Record<AssessmentBodyField, string>> = {
    weightKg: 'peso',
    bodyFatPct: 'gordura corporal',
    waistCm: 'cintura/abdômen',
    neckCm: 'pescoço',
    hipCm: 'quadril',
    thighCm: 'coxa',
    chestCm: 'tórax',
    abdomenCm: 'abdômen',
    forearmRightCm: 'antebraço direito',
    forearmLeftCm: 'antebraço esquerdo',
    calfRightCm: 'panturrilha direita',
    calfLeftCm: 'panturrilha esquerda',
    armRightCm: 'braço direito',
    armLeftCm: 'braço esquerdo',
    thighRightCm: 'coxa direita',
    thighLeftCm: 'coxa esquerda',
    chestSkinfoldMm: 'dobra peitoral',
    abdomenSkinfoldMm: 'dobra abdominal',
    thighSkinfoldMm: 'dobra da coxa',
  };
  const fields = [...new Set(selected.map(({ field }) => field))].map((field) => fieldNames[field]);
  return `Avaliação local ${assessment.assessedOn} [assessment:${assessment.id}] · Campos: ${fields.join(', ')}${methods.length ? ` · Método: ${methods.join(', ')}` : ''}`;
}

/** SHA-256 do registro estruturado, usado só como chave local para evitar nova transferência após reimportação. */
export async function assessmentBodyFingerprint(
  assessment: LocalPhysicalAssessment,
): Promise<string> {
  const measurements = assessmentBodyCandidates(assessment)
    .map(({ field, value, measure }) => ({
      field,
      value,
      unit: measure.unit.trim().toLocaleLowerCase('pt-BR'),
      kind: measure.kind,
      method: measure.method?.trim() ?? null,
      source: measure.source?.trim() ?? null,
    }))
    .sort((a, b) => `${a.field}:${a.value}`.localeCompare(`${b.field}:${b.value}`));
  const payload = JSON.stringify({
    assessedOn: assessment.assessedOn,
    origin: assessment.origin?.trim() ?? null,
    professional: assessment.professional?.trim() ?? null,
    measurements,
  });
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(payload),
  );
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function fatMethod(measure: PhysicalAssessmentMeasure): 'navy' | 'manual' | 'bioimpedance' {
  if (measure.kind === 'calculated') return 'navy';
  return measure.method?.toLocaleLowerCase('pt-BR').includes('bioimped')
    ? 'bioimpedance'
    : 'manual';
}

function safeMethod(method: string | null | undefined): string {
  const normalized = method?.trim().toLocaleLowerCase('pt-BR');
  if (normalized === 'marinha' || normalized === 'navy') return 'Marinha';
  if (normalized === 'bioimpedância' || normalized === 'bioimpedancia') return 'bioimpedância';
  if (normalized === 'fita' || normalized === 'fita métrica') return 'fita métrica';
  if (normalized === 'balança') return 'balança';
  return '';
}
