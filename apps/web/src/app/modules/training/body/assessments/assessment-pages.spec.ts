import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';
import { PhysicalAssessmentRepository } from '../../data/physical-assessments/physical-assessment-repository';
import { BodyRepository } from '../../data/body/body-repository';
import { TRAINING_DB } from '../../data/training-db';
import { eventually, setupScreen } from '../../shell/screen-test-kit';
import { TRAINING_ROUTES } from '../../training.routes';

describe('physical assessment screens', () => {
  async function open(url: string) {
    const kit = await setupScreen([
      { path: 'treino', data: { title: 'Treino' }, children: TRAINING_ROUTES },
    ]);
    const harness = await kit.harness();
    await harness.navigateByUrl(url);
    return { harness, kit };
  }

  it('shows the private history and keeps measurement provenance distinct', async () => {
    const kit = await setupScreen([
      { path: 'treino', data: { title: 'Treino' }, children: TRAINING_ROUTES },
    ]);
    const repository = TestBed.inject(PhysicalAssessmentRepository);
    const row = await repository.save({
      assessedOn: '2026-01-12',
      origin: 'Clínica sintética',
      professional: 'Profissional de teste',
      measurements: [
        {
          type: 'calf',
          reportedValue: '00',
          unit: 'cm',
          kind: 'measured',
          side: 'left',
          method: 'fita',
          source: 'relatório de teste',
        },
        {
          type: 'pollock-3-body-fat',
          reportedValue: 14.2,
          unit: '%',
          kind: 'calculated',
          method: 'Pollock 3',
        },
        { type: 'waist', reportedValue: 81, unit: 'cm', kind: 'reference' },
      ],
    });
    const harness = await kit.harness();
    await harness.navigateByUrl('/treino/corpo/avaliacoes');
    const el = harness.routeNativeElement as HTMLElement;
    await eventually({ detectChanges: () => harness.detectChanges() }, () => {
      expect(el.textContent).toContain('Somente Neste Aparelho');
      expect(el.textContent).toContain('Clínica sintética');
    });
    await harness.navigateByUrl(`/treino/corpo/avaliacoes/${row.id}`);
    const detail = harness.routeNativeElement as HTMLElement;
    await eventually({ detectChanges: () => harness.detectChanges() }, () => {
      expect(detail.textContent).toContain('00 cm');
      expect(detail.textContent).toContain('Medido');
      expect(detail.textContent).toContain('Calculado pela origem');
      expect(detail.textContent).toContain('Referência sugerida');
      expect(detail.textContent).toContain('Pollock 3');
    });
  });

  it('previews an export and saves only individually confirmed fields', async () => {
    const { harness } = await open('/treino/corpo/avaliacoes/importar');
    const json = {
      app: 'uniover',
      module: 'training',
      exportType: 'physical-assessment',
      exportVersion: 1,
      assessment: {
        id: 'synthetic-source',
        assessedOn: '2026-03-04',
        origin: 'Origem sintética',
        professional: 'Profissional sintético',
        reportedAgeYears: 42,
        statedGoal: null,
        activityStatus: null,
        plannedFrequencyPerWeek: null,
        notes: null,
        measurements: [
          {
            type: 'chest',
            reportedValue: 101,
            unit: 'cm',
            kind: 'measured',
            method: 'fita',
            source: 'relatório sintético',
          },
          {
            type: 'calf',
            reportedValue: '00',
            unit: 'cm',
            kind: 'measured',
            side: 'right',
            method: 'fita',
          },
        ],
        documents: [
          {
            name: 'relatorio-sintetico.jpg',
            mediaType: 'image/jpeg',
            dataBase64: '/9j/',
          },
        ],
      },
    };
    const file = new File([JSON.stringify(json)], 'avaliacao-sintetica.json', {
      type: 'application/json',
    });
    const input = harness.routeNativeElement!.querySelector<HTMLInputElement>('#assessment-file')!;
    Object.defineProperty(input, 'files', { configurable: true, value: [file] });
    input.dispatchEvent(new Event('change'));
    await harness.fixture.whenStable();
    harness.detectChanges();
    expect((harness.routeNativeElement as HTMLElement).textContent).toContain('Prévia carregada');

    const measureCandidate = Array.from(
      harness.routeNativeElement!.querySelectorAll<HTMLElement>('.candidate'),
    ).find((candidate) => candidate.textContent?.includes('Resultado 1'));
    expect(measureCandidate).toBeDefined();
    const editType =
      harness.routeNativeElement!.querySelector<HTMLInputElement>('#type-measurement-0')!;
    editType.value = 'Tórax ajustado';
    editType.dispatchEvent(new Event('input'));
    const editValue =
      harness.routeNativeElement!.querySelector<HTMLInputElement>('#value-measurement-0')!;
    editValue.value = '102';
    editValue.dispatchEvent(new Event('input'));
    measureCandidate!.querySelector<HTMLInputElement>('.confirm-field input')!.click();
    expect((harness.routeNativeElement as HTMLElement).textContent).toContain(
      'Confirme as imagens',
    );
    const documentChoice =
      harness.routeNativeElement!.querySelector<HTMLInputElement>('#document-0')!;
    documentChoice.checked = true;
    documentChoice.dispatchEvent(new Event('change', { bubbles: true }));
    await harness.fixture.whenStable();
    harness.detectChanges();
    expect(
      harness.routeNativeElement!.querySelector<HTMLInputElement>('#document-0')!.checked,
    ).toBe(true);
    harness.routeNativeElement!.querySelector<HTMLButtonElement>('button.primary')!.click();
    await harness.fixture.whenStable();
    harness.detectChanges();

    const rows = await TestBed.inject(PhysicalAssessmentRepository).list();
    expect(rows).toHaveLength(1);
    expect(rows[0].assessedOn).toBe('2026-03-04');
    expect(rows[0].origin).toBeNull();
    expect(rows[0].reportedAgeYears).toBeNull();
    expect(rows[0].measurements).toEqual([
      {
        type: 'Tórax ajustado',
        reportedValue: '102',
        unit: 'cm',
        kind: 'measured',
        side: null,
        method: 'fita',
        source: 'relatório sintético',
      },
    ]);
    const documents = await vi.waitFor(async () => {
      const saved = await TestBed.inject(PhysicalAssessmentRepository).documents(rows[0].id);
      expect(saved).toHaveLength(1);
      return saved;
    });
    expect(documents.map((document) => document.name)).toEqual(['relatorio-sintetico.jpg']);
  });

  it('transfers only explicitly selected supported fields, preserves provenance and date, and deduplicates re-imports', async () => {
    const kit = await setupScreen([
      { path: 'treino', data: { title: 'Treino' }, children: TRAINING_ROUTES },
    ]);
    const assessments = TestBed.inject(PhysicalAssessmentRepository);
    const row = await assessments.save({
      assessedOn: '2025-03-04',
      origin: 'Clínica sintética',
      professional: 'Profissional sintético',
      measurements: [
        {
          type: 'weight',
          reportedValue: 82.4,
          unit: 'kg',
          kind: 'measured',
          method: 'balança',
          source: 'relatório sintético',
        },
        { type: 'waist', reportedValue: 86, unit: 'cm', kind: 'measured', method: 'fita' },
        { type: 'calf', reportedValue: 39, unit: 'cm', kind: 'measured', side: 'right' },
        { type: 'body-fat', reportedValue: '00', unit: '%', kind: 'measured' },
      ],
    });
    await assessments.addDocument(
      row.id,
      new Blob([new Uint8Array([0x41, 0x42])], { type: 'image/jpeg' }),
      'imagem-sintetica.jpg',
    );

    const harness = await kit.harness();
    await harness.navigateByUrl(`/treino/corpo/avaliacoes/${row.id}`);
    const page = harness.routeNativeElement as HTMLElement;
    await eventually({ detectChanges: () => harness.detectChanges() }, () => {
      expect(page.textContent).toContain('Registro histórico');
    });
    const transferButton = Array.from(page.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Levar medidas ao Corpo'),
    )!;
    transferButton.click();
    await eventually({ detectChanges: () => harness.detectChanges() }, () => {
      expect(page.textContent).toContain('Escolher Medidas para o Corpo');
      // Peso, cintura e a panturrilha direita (a medida com lado agora tem campo próprio no Corpo).
      expect(page.querySelectorAll('.transfer-option')).toHaveLength(3);
    });

    const choices = Array.from(page.querySelectorAll<HTMLInputElement>('.transfer-option input'));
    expect(choices).toHaveLength(3);
    expect(choices.every((choice) => !choice.checked)).toBe(true);
    choices[0].click();
    await eventually({ detectChanges: () => harness.detectChanges() }, () => {
      expect(page.textContent).toContain('Anotação que será registrada no Corpo');
    });
    expect(choices[0].checked).toBe(true);
    page.querySelector<HTMLButtonElement>('.transfer-actions .primary')!.click();
    await harness.fixture.whenStable();
    harness.detectChanges();

    const body = TestBed.inject(BodyRepository);
    await vi.waitFor(async () => expect(await body.entries()).toHaveLength(1));
    const entries = await body.entries();
    expect(entries[0]).toMatchObject({
      measuredOn: '2025-03-04',
      weightKg: 82.4,
      waistCm: null,
    });
    expect(entries[0].note).toContain('balança');
    expect(entries[0].note).not.toContain('Clínica sintética');
    expect(entries[0].note).not.toContain('relatório sintético');
    expect(entries[0].note).toContain('[assessment:');
    expect(await TestBed.inject(TRAINING_DB).photos.count()).toBe(0);
    expect(await assessments.documents(row.id)).toHaveLength(1);
    expect(await kit.db.outbox.count()).toBe(1);
    expect(await kit.db.outbox.toArray()).toMatchObject([
      { method: 'PUT', url: expect.stringContaining('/training/body/entries/') },
    ]);

    await assessments.save({
      assessedOn: row.assessedOn,
      origin: row.origin,
      professional: row.professional,
      measurements: row.measurements,
    });
    const reimport = (await assessments.list()).find((candidate) => candidate.id !== row.id)!;
    await harness.navigateByUrl('/treino/corpo/avaliacoes');
    await harness.navigateByUrl(`/treino/corpo/avaliacoes/${reimport.id}`);
    const reimportPage = harness.routeNativeElement as HTMLElement;
    await eventually({ detectChanges: () => harness.detectChanges() }, () => {
      expect(reimportPage.textContent).toContain('Registro histórico');
    });
    Array.from(reimportPage.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('Levar medidas ao Corpo'))!
      .click();
    await eventually({ detectChanges: () => harness.detectChanges() }, () => {
      expect(reimportPage.textContent).toContain('Este campo já foi registrado');
    });
    const reimportChoices = Array.from(
      reimportPage.querySelectorAll<HTMLInputElement>('.transfer-option input'),
    );
    expect(reimportChoices.filter((choice) => choice.disabled)).toHaveLength(1);
    const remaining = reimportChoices.find((choice) => !choice.disabled)!;
    remaining.click();
    await eventually({ detectChanges: () => harness.detectChanges() }, () => {
      expect(reimportPage.textContent).toContain('Anotação que será registrada no Corpo');
    });
    reimportPage.querySelector<HTMLButtonElement>('.transfer-actions .primary')!.click();
    await vi.waitFor(async () => expect(await body.entries()).toHaveLength(2));
    const allEntries = await body.entries();
    expect(allEntries.map((entry) => [entry.weightKg, entry.waistCm])).toContainEqual([82.4, null]);
    expect(allEntries.map((entry) => [entry.weightKg, entry.waistCm])).toContainEqual([null, 86]);
    expect(await kit.db.outbox.count()).toBe(2);
    expect(await TestBed.inject(TRAINING_DB).photos.count()).toBe(0);
  });

  it('rejects malformed image data before saving any imported assessment', async () => {
    const { harness } = await open('/treino/corpo/avaliacoes/importar');
    const json = {
      app: 'uniover',
      module: 'training',
      exportType: 'physical-assessment',
      exportVersion: 1,
      assessment: {
        assessedOn: '2026-03-04',
        measurements: [],
        documents: [
          {
            name: 'imagem-sintetica.jpg',
            mediaType: 'image/jpeg',
            dataBase64: 'not-base64',
          },
        ],
      },
    };
    const file = new File([JSON.stringify(json)], 'avaliacao-sintetica.json', {
      type: 'application/json',
    });
    const input = harness.routeNativeElement!.querySelector<HTMLInputElement>('#assessment-file')!;
    Object.defineProperty(input, 'files', { configurable: true, value: [file] });
    input.dispatchEvent(new Event('change'));
    await harness.fixture.whenStable();
    harness.detectChanges();

    expect((harness.routeNativeElement as HTMLElement).textContent).not.toContain(
      'Prévia carregada',
    );
    expect(await TestBed.inject(PhysicalAssessmentRepository).list()).toHaveLength(0);
  });
});
