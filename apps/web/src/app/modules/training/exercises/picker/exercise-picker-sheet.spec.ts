import { TestBed } from '@angular/core/testing';
import { CatalogRepository } from '../../data/catalog/catalog-repository';
import { catalog, eventually, setupScreen } from '../../shell/screen-test-kit';
import { ExercisePickerSheet } from './exercise-picker-sheet';

describe('ExercisePickerSheet', () => {
  async function open() {
    const kit = await setupScreen();
    await kit.trainingDb.exercises.bulkPut(catalog());
    const fixture = TestBed.createComponent(ExercisePickerSheet);
    document.body.append(fixture.nativeElement);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    return { fixture, el };
  }

  const names = (el: HTMLElement) =>
    Array.from(el.querySelectorAll('.list .name')).map((node) => node.textContent?.trim());

  afterEach(() => {
    document.body.replaceChildren();
  });

  it('lists the catalog and rereads it once after the typing stops, not on every letter', async () => {
    const { fixture, el } = await open();
    await eventually(fixture, () => expect(names(el)).toHaveLength(5));
    const reread = vi.spyOn(TestBed.inject(CatalogRepository), 'search');

    const input = el.querySelector<HTMLInputElement>('#picker-search')!;
    for (const partial of ['i', 'in', 'incl', 'inclin']) {
      input.value = partial;
      input.dispatchEvent(new Event('input'));
    }
    // O campo mostra o que foi digitado na hora; a lista espera a pausa.
    expect(input.value).toBe('inclin');
    expect(reread).not.toHaveBeenCalled();

    await eventually(fixture, () => expect(names(el)).toEqual(['Supino inclinado com halteres']));
    expect(reread).toHaveBeenCalledTimes(1);
  });

  it('leaves the wait with "nothing found" when the local database fails', async () => {
    const { fixture, el } = await open();
    await eventually(fixture, () => expect(names(el)).toHaveLength(5));
    vi.spyOn(TestBed.inject(CatalogRepository), 'search').mockRejectedValue(new Error('indexeddb'));

    const input = el.querySelector<HTMLInputElement>('#picker-search')!;
    input.value = 'supino';
    input.dispatchEvent(new Event('input'));

    await eventually(fixture, () => expect(el.textContent).toContain('Nenhum exercício achado.'));
  });
});
