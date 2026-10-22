import { TestBed } from '@angular/core/testing';
import { TRAINING_EXPORT_SECTIONS } from '../export/export-sections';
import { ExportService } from '../export/export-service';
import { setupTraining } from '../sync/training-test-kit';
import { TRAINING_DB } from '../training-db';
import { PhysicalAssessmentExport } from './physical-assessment-export';
import {
  ASSESSMENT_DOCUMENTS_MAX_BYTES,
  PhysicalAssessmentRepository,
} from './physical-assessment-repository';

describe('PhysicalAssessmentRepository', () => {
  it('preserves historical date, provenance, reported text, sides, methods and value kinds', async () => {
    const t = setupTraining();
    t.pause();
    const repository = TestBed.inject(PhysicalAssessmentRepository);
    const saved = await repository.save({
      assessedOn: '2026-10-08',
      origin: 'Relatório sintético',
      professional: 'Profissional de teste',
      reportedAgeYears: 32,
      statedGoal: 'Acompanhar medidas',
      activityStatus: 'Inativo no dia da avaliação',
      plannedFrequencyPerWeek: 4,
      measurements: [
        {
          type: 'chest',
          reportedValue: 98.5,
          unit: 'cm',
          kind: 'measured',
          source: 'fita métrica',
        },
        { type: 'abdomen', reportedValue: '00', unit: 'cm', kind: 'reference', side: 'left' },
        { type: 'forearm', reportedValue: 28, unit: 'cm', kind: 'measured', side: 'left' },
        { type: 'forearm', reportedValue: 29, unit: 'cm', kind: 'measured', side: 'right' },
        { type: 'calf', reportedValue: 36, unit: 'cm', kind: 'measured', side: 'left' },
        { type: 'calf', reportedValue: 37, unit: 'cm', kind: 'measured', side: 'right' },
        {
          type: 'skinfold-chest',
          reportedValue: 8,
          unit: 'mm',
          kind: 'measured',
          method: 'Pollock 3',
        },
        {
          type: 'pollock-3-body-fat',
          reportedValue: 14.2,
          unit: '%',
          kind: 'calculated',
          method: 'Pollock 3',
        },
      ],
    });

    expect(saved.assessedOn).toBe('2026-10-08');
    expect(saved).toMatchObject({
      reportedAgeYears: 32,
      statedGoal: 'Acompanhar medidas',
      activityStatus: 'Inativo no dia da avaliação',
      plannedFrequencyPerWeek: 4,
    });
    expect(saved.measurements).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ reportedValue: '00', kind: 'reference' }),
        expect.objectContaining({ type: 'forearm', side: 'left' }),
        expect.objectContaining({ type: 'forearm', side: 'right' }),
        expect.objectContaining({ type: 'calf', side: 'left' }),
        expect.objectContaining({ type: 'calf', side: 'right' }),
        expect.objectContaining({ kind: 'calculated', method: 'Pollock 3' }),
      ]),
    );
    expect(await repository.list()).toEqual([saved]);
    expect(await t.db.outbox.count()).toBe(0);
  });

  it('supports a historical record with no measurements and keeps its original date when another is added', async () => {
    setupTraining();
    const repository = TestBed.inject(PhysicalAssessmentRepository);
    const first = await repository.save({ assessedOn: '2026-08-01' });
    const second = await repository.save({ assessedOn: '2026-10-08', measurements: [] });
    expect(first.measurements).toEqual([]);
    expect((await repository.get(first.id))?.assessedOn).toBe('2026-08-01');
    expect((await repository.list()).map((entry) => entry.assessedOn)).toEqual([
      '2026-08-01',
      '2026-10-08',
    ]);
    expect(second.id).not.toBe(first.id);
  });

  it('stores only supported document images in their own table and never in progress photos', async () => {
    const t = setupTraining();
    const repository = TestBed.inject(PhysicalAssessmentRepository);
    const assessment = await repository.save({ assessedOn: '2026-10-08' });
    const image = new Blob([new Uint8Array([0x41, 0x42, 0x43])], { type: 'image/png' });
    const added = await repository.addDocument(assessment.id, image, 'relatorio.png');

    expect(added.status).toBe('saved');
    if (added.status !== 'saved') return;
    expect(added.document).toMatchObject({
      assessmentId: assessment.id,
      name: 'relatorio.png',
      bytes: 3,
    });
    expect(new Uint8Array((await repository.documentData(added.document.id))!)).toEqual(
      new Uint8Array([0x41, 0x42, 0x43]),
    );
    expect(await t.trainingDb.assessmentDocuments.count()).toBe(1);
    expect(await t.trainingDb.photos.count()).toBe(0);
    expect(
      await repository.addDocument(assessment.id, new Blob(['<svg/>'], { type: 'image/svg+xml' })),
    ).toEqual({
      status: 'invalid-type',
    });
  });

  it('enforces per-assessment attachment size before storing more bytes', async () => {
    setupTraining();
    const repository = TestBed.inject(PhysicalAssessmentRepository);
    const assessment = await repository.save({ assessedOn: '2026-10-08' });
    const oversized = new Blob([new Uint8Array(ASSESSMENT_DOCUMENTS_MAX_BYTES + 1)], {
      type: 'image/png',
    });
    expect(await repository.addDocument(assessment.id, oversized)).toEqual({ status: 'too-large' });
  });

  it('exports a record only through the explicit assessment export and excludes it from common training export', async () => {
    const t = setupTraining();
    const repository = TestBed.inject(PhysicalAssessmentRepository);
    const assessment = await repository.save({
      assessedOn: '2026-10-08',
      measurements: [
        { type: 'arm-contracted', reportedValue: 31, unit: 'cm', kind: 'measured', side: 'right' },
      ],
    });
    const added = await repository.addDocument(
      assessment.id,
      new Blob([new Uint8Array([0x61, 0x62])], { type: 'image/jpeg' }),
      'documento.jpg',
    );
    expect(added.status).toBe('saved');

    const standard = await TestBed.inject(ExportService).buildJson();
    expect(standard.sections).not.toHaveProperty('physicalAssessments');
    expect(standard.sections).not.toHaveProperty('assessmentDocuments');
    const explicit = (await TestBed.inject(PhysicalAssessmentExport).build(assessment.id)) as {
      assessment: { assessedOn: string; documents: { dataBase64: string }[] };
    };
    expect(explicit.assessment.assessedOn).toBe('2026-10-08');
    expect(explicit.assessment.documents[0]?.dataBase64).toBe('YWI=');
    expect(await TestBed.inject(PhysicalAssessmentExport).build('inexistente')).toBeNull();
    expect(t.trainingDb).toBe(TestBed.inject(TRAINING_DB));
    expect(TestBed.inject(TRAINING_EXPORT_SECTIONS).map((section) => section.key)).not.toContain(
      'physicalAssessments',
    );
  });

  it('deletes a record and its documents atomically', async () => {
    const t = setupTraining();
    const repository = TestBed.inject(PhysicalAssessmentRepository);
    const assessment = await repository.save({ assessedOn: '2026-10-08' });
    await repository.addDocument(
      assessment.id,
      new Blob([new Uint8Array([0x41])], { type: 'image/png' }),
    );
    expect(await repository.delete(assessment.id)).toBe(true);
    expect(await repository.get(assessment.id)).toBeUndefined();
    expect(await t.trainingDb.assessmentDocuments.count()).toBe(0);
    expect(await repository.delete(assessment.id)).toBe(false);
  });
});
