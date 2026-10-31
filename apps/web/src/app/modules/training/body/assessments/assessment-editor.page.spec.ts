import { TestBed } from '@angular/core/testing';
import { PhysicalAssessmentRepository } from '../../data/physical-assessments/physical-assessment-repository';
import { eventually, setupScreen } from '../../shell/screen-test-kit';
import { TRAINING_ROUTES } from '../../training.routes';

describe('PhysicalAssessmentEditorPage', () => {
  async function open(url: string) {
    const kit = await setupScreen([
      { path: 'treino', data: { title: 'Treino' }, children: TRAINING_ROUTES },
    ]);
    const harness = await kit.harness();
    await harness.navigateByUrl(url);
    const el = harness.routeNativeElement as HTMLElement;
    return { harness, el };
  }

  const saveButton = (el: HTMLElement) =>
    Array.from(el.querySelectorAll<HTMLButtonElement>('button')).find(
      (node) => node.textContent?.trim() === 'Salvar Avaliação',
    )!;

  function type(el: HTMLElement, selector: string, value: string) {
    const input = el.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector)!;
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }

  it('keeps Save in the fixed bar, off until something changes', async () => {
    const { harness, el } = await open('/treino/corpo/avaliacoes/nova');
    await eventually({ detectChanges: () => harness.detectChanges() }, () =>
      expect(saveButton(el)).toBeDefined(),
    );
    expect(el.querySelector('.ui-action-bar')?.contains(saveButton(el))).toBe(true);
    expect(el.querySelector('form')?.classList.contains('ui-has-action-bar')).toBe(true);
    expect(saveButton(el).disabled).toBe(true);

    type(el, '#origin', 'Clínica sintética');
    harness.detectChanges();
    expect(saveButton(el).disabled).toBe(false);

    // Voltar ao que estava desfaz a mudança.
    type(el, '#origin', '');
    harness.detectChanges();
    expect(saveButton(el).disabled).toBe(true);
  });

  it('turns Save off when the date is cleared', async () => {
    const { harness, el } = await open('/treino/corpo/avaliacoes/nova');
    await eventually({ detectChanges: () => harness.detectChanges() }, () =>
      expect(saveButton(el)).toBeDefined(),
    );
    type(el, '#origin', 'Clínica sintética');
    harness.detectChanges();
    expect(saveButton(el).disabled).toBe(false);

    type(el, '#assessedOn', '');
    harness.detectChanges();
    expect(saveButton(el).disabled).toBe(true);
  });

  it('counts a measurement row and a staged file as changes', async () => {
    const { harness, el } = await open('/treino/corpo/avaliacoes/nova');
    await eventually({ detectChanges: () => harness.detectChanges() }, () =>
      expect(saveButton(el)).toBeDefined(),
    );
    const add = Array.from(el.querySelectorAll<HTMLButtonElement>('button')).find((node) =>
      node.textContent?.includes('Adicionar Medida'),
    )!;
    add.click();
    harness.detectChanges();
    expect(saveButton(el).disabled).toBe(false);
  });

  it('opens an existing assessment with Save off, and on after an edit', async () => {
    const kit = await setupScreen([
      { path: 'treino', data: { title: 'Treino' }, children: TRAINING_ROUTES },
    ]);
    const row = await TestBed.inject(PhysicalAssessmentRepository).save({
      assessedOn: '2026-01-12',
      origin: 'Clínica sintética',
      measurements: [],
    });
    const harness = await kit.harness();
    await harness.navigateByUrl(`/treino/corpo/avaliacoes/${row.id}/editar`);
    const el = harness.routeNativeElement as HTMLElement;
    await eventually({ detectChanges: () => harness.detectChanges() }, () =>
      expect(el.querySelector<HTMLInputElement>('#origin')?.value).toBe('Clínica sintética'),
    );
    expect(saveButton(el).disabled).toBe(true);

    type(el, '#notes', 'Observação nova');
    harness.detectChanges();
    expect(saveButton(el).disabled).toBe(false);
  });
});
