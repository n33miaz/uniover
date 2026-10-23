import {
  assessmentBodyCandidates,
  assessmentBodyDraft,
  assessmentBodyFingerprint,
  assessmentBodyNoteTooLong,
  assessmentBodyTransferredFields,
} from './assessment-body-transfer';
import type { LocalPhysicalAssessment } from '../../data/physical-assessments/physical-assessment';
import type { LocalBodyEntry } from '../../data/body/body-entry';
import { BODY_LIMITS } from '../../domain/body/body-limits';

function assessment(
  measurements: NonNullable<LocalPhysicalAssessment['measurements']>,
  overrides: Partial<LocalPhysicalAssessment> = {},
): LocalPhysicalAssessment {
  return {
    id: 'assessment-a',
    assessedOn: '2026-10-08',
    origin: 'Clínica sintética',
    professional: 'Profissional sintético',
    measurements,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function bodyEntry(note: string, values: Partial<LocalBodyEntry> = {}): LocalBodyEntry {
  return {
    id: 'body-entry-a',
    measuredOn: '2026-10-08',
    weightKg: null,
    bodyFatPct: null,
    fatMethod: null,
    waistCm: null,
    neckCm: null,
    hipCm: null,
    armCm: null,
    thighCm: null,
    note,
    updatedAt: 1,
    clientUpdatedAt: 1,
    deletedAt: null,
    ...values,
  };
}

describe('assessment to body transfer', () => {
  it('offers only unambiguous supported values and never promotes references, placeholders or side-specific values', () => {
    const row = assessment([
      { type: 'weight', reportedValue: '82,4', unit: 'kg', kind: 'measured', method: 'balança' },
      { type: 'waist', reportedValue: 86, unit: 'cm', kind: 'measured', source: 'fita' },
      { type: 'abdomen', reportedValue: 80, unit: 'cm', kind: 'measured' },
      { type: 'calf', reportedValue: 39, unit: 'cm', kind: 'measured', side: 'left' },
      { type: 'height', reportedValue: 180, unit: 'cm', kind: 'measured' },
      { type: 'body-fat', reportedValue: '00', unit: '%', kind: 'measured' },
      { type: 'body-fat', reportedValue: 14, unit: '%', kind: 'calculated', method: 'Pollock 3' },
      { type: 'hip', reportedValue: 90, unit: 'cm', kind: 'reference' },
    ]);

    expect(assessmentBodyCandidates(row)).toMatchObject([
      { field: 'weightKg', value: 82.4 },
      { field: 'waistCm', value: 86 },
    ]);
    expect(assessmentBodyCandidates(row).map(({ field }) => field)).toEqual([
      'weightKg',
      'waistCm',
    ]);
  });

  it('does not map abdomen to waist without an explicit site equivalence', () => {
    const row = assessment([{ type: 'abdomen', reportedValue: 80, unit: 'cm', kind: 'measured' }]);

    expect(assessmentBodyCandidates(row)).toEqual([]);
  });

  it('maps the assessed day, exact supported values and source details into a single body entry', () => {
    const row = assessment([
      {
        type: 'body-fat',
        reportedValue: 16.9,
        unit: '%',
        kind: 'calculated',
        method: 'Marinha',
        source: 'relatório sintético',
      },
      { type: 'waist', reportedValue: 86, unit: 'cm', kind: 'measured', method: 'fita' },
      { type: 'neck', reportedValue: 38, unit: 'cm', kind: 'measured' },
      { type: 'thigh', reportedValue: 58.2, unit: 'cm', kind: 'measured' },
    ]);
    const draft = assessmentBodyDraft(row, assessmentBodyCandidates(row));

    expect(draft).toEqual({
      measuredOn: '2026-10-08',
      bodyFatPct: 16.9,
      fatMethod: 'navy',
      waistCm: 86,
      neckCm: 38,
      thighCm: 58.2,
      note: expect.stringContaining('Avaliação local 2026-10-08'),
    });
    expect(draft.note).toContain('Marinha');
    expect(draft.note).not.toContain('Clínica sintética');
    expect(draft.note).not.toContain('relatório sintético');
  });

  it('omits values whose precision cannot be stored without rounding', () => {
    const row = assessment([
      { type: 'weight', reportedValue: 82.456, unit: 'kg', kind: 'measured' },
      { type: 'thigh', reportedValue: 58.25, unit: 'cm', kind: 'measured' },
    ]);

    expect(assessmentBodyCandidates(row)).toEqual([]);
  });

  it('counts the appended field marker toward the Body note limit', () => {
    const row = assessment(
      [
        { type: 'weight', reportedValue: 82, unit: 'kg', kind: 'measured' },
        { type: 'body-fat', reportedValue: 15, unit: '%', kind: 'measured' },
        { type: 'waist', reportedValue: 80, unit: 'cm', kind: 'measured' },
        { type: 'neck', reportedValue: 38, unit: 'cm', kind: 'measured' },
        { type: 'hip', reportedValue: 94, unit: 'cm', kind: 'measured' },
        { type: 'thigh', reportedValue: 58, unit: 'cm', kind: 'measured' },
      ],
      { id: 'a'.repeat(170) },
    );
    const candidates = assessmentBodyCandidates(row);

    expect(assessmentBodyNoteTooLong(row, candidates)).toBe(true);
    expect(assessmentBodyDraft(row, candidates).note?.length).toBeGreaterThan(BODY_LIMITS.noteMax);
  });

  it('keeps identical re-imports idempotent while ignoring local ids and attached images', async () => {
    const row = assessment([
      { type: 'weight', reportedValue: 82.4, unit: 'kg', kind: 'measured', source: 'balança' },
    ]);
    const first = await assessmentBodyFingerprint(row);
    const second = await assessmentBodyFingerprint({
      ...row,
      id: 'assessment-b',
      createdAt: 100,
      updatedAt: 100,
    });

    expect(second).toBe(first);
  });

  it('recognizes only the fields actually transferred from the same assessment', () => {
    const row = assessment([
      { type: 'weight', reportedValue: 82.4, unit: 'kg', kind: 'measured' },
      { type: 'waist', reportedValue: 86, unit: 'cm', kind: 'measured' },
    ]);
    const candidates = assessmentBodyCandidates(row);
    const saved = assessmentBodyDraft(row, [candidates[0]]);
    const entry = bodyEntry(saved.note ?? '', { weightKg: 82.4 });

    expect(assessmentBodyTransferredFields(row, candidates, [entry])).toEqual(['weightKg']);
  });

  it('allows a field to be transferred again if its Body entry was edited or deleted', async () => {
    const row = assessment([{ type: 'weight', reportedValue: 82.4, unit: 'kg', kind: 'measured' }]);
    const candidates = assessmentBodyCandidates(row);
    const saved = assessmentBodyDraft(row, candidates);
    const edited = bodyEntry(saved.note ?? '', { weightKg: 80 });

    expect(assessmentBodyTransferredFields(row, candidates, [edited])).toEqual([]);
    expect(assessmentBodyTransferredFields(row, candidates, [])).toEqual([]);
  });

  it('reads partial legacy transfer notes by matching the saved values', async () => {
    const row = assessment([
      { type: 'weight', reportedValue: 82.4, unit: 'kg', kind: 'measured' },
      { type: 'waist', reportedValue: 86, unit: 'cm', kind: 'measured' },
    ]);
    const candidates = assessmentBodyCandidates(row);
    const legacy = bodyEntry('Avaliação local 2026-10-08 [assessment:assessment-a]', {
      weightKg: 82.4,
    });

    expect(assessmentBodyTransferredFields(row, candidates, [legacy])).toEqual(['weightKg']);
  });
});
