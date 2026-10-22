import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';
import { PhysicalAssessmentRepository } from '../../data/physical-assessments/physical-assessment-repository';
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
      expect(el.textContent).toContain('Somente neste aparelho');
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
