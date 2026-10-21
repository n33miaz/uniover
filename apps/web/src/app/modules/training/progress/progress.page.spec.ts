import { vi } from 'vitest';
import type { LocalExercise } from '../data/catalog/exercise';
import { localExercise } from '../data/sync/training-test-kit';
import { eventually, seedHistory } from '../shell/screen-test-kit';
import type { TrainingDb } from '../data/training-db';
import { BENCH_HISTORY, setupProgress } from './progress-test-kit';
import { CHIP_LIMIT, ProgressPage } from './progress.page';

const text = (el: Element | null | undefined) => el?.textContent?.replace(/\s+/g, ' ').trim() ?? '';

describe('ProgressPage', () => {
  async function open(
    url: string,
    seed: (db: TrainingDb) => Promise<void> = async () => undefined,
    extra: LocalExercise[] = [],
  ) {
    const kit = await setupProgress([
      { path: 'treino/progresso', component: ProgressPage },
      { path: '**', children: [] },
    ]);
    if (extra.length > 0) await kit.trainingDb.exercises.bulkPut(extra);
    await seed(kit.trainingDb);
    const harness = await kit.harness();
    await harness.navigateByUrl(url, ProgressPage);
    const el = harness.routeNativeElement as HTMLElement;
    return { ...kit, fixture: harness.fixture, el };
  }

  const chips = (el: HTMLElement) =>
    Array.from(el.querySelectorAll('app-training-chips button')).map((chip) => text(chip));
  const pressedChip = (el: HTMLElement) =>
    text(el.querySelector('app-training-chips button[aria-pressed="true"]'));
  const chip = (el: HTMLElement, label: string) =>
    Array.from(el.querySelectorAll<HTMLButtonElement>('app-training-chips button')).find(
      (node) => text(node) === label,
    )!;
  const sectionTitles = (el: HTMLElement) =>
    Array.from(el.querySelectorAll('.sections button.toggle .ui-row-title')).map((title) =>
      text(title),
    );

  /** Supino (seis semanas, o último treino no dia 99) e agachamento (um treino no dia 105, mais recente). */
  async function seedTwo(db: TrainingDb) {
    await seedHistory(db, 'supino-reto', BENCH_HISTORY);
    await seedHistory(db, 'agachamento', [[105, 60, 8]]);
  }

  it('only explains what to do, with a way to Hoje, when no training was ever recorded', async () => {
    const { fixture, el } = await open('/treino/progresso');
    await eventually(fixture, () =>
      expect(text(el.querySelector('h2'))).toBe('Registre um treino para ver o progresso'),
    );

    expect(el.querySelector('a[href="/treino"]')).not.toBeNull();
    expect(el.querySelector('app-progress-evolution')).toBeNull();
    expect(el.querySelector('.sections')).toBeNull();
  });

  it('opens on the exercise trained most recently, with the others as chips in that order', async () => {
    const { fixture, el } = await open('/treino/progresso', seedTwo);
    await eventually(fixture, () => expect(chips(el)).toHaveLength(2));

    expect(chips(el)).toEqual(['Agachamento livre', 'Supino reto com barra']);
    expect(pressedChip(el)).toBe('Agachamento livre');
    await eventually(fixture, () => expect(text(el.querySelector('.value'))).toBe('76 kg'));
  });

  it('opens on the exercise of the address, the one the exercise sheet links to', async () => {
    const { fixture, el } = await open('/treino/progresso?exercise=supino-reto', seedTwo);
    await eventually(fixture, () => expect(pressedChip(el)).toBe('Supino reto com barra'));
    await eventually(fixture, () => expect(text(el.querySelector('.value'))).toBe('53,8 kg'));
  });

  it('ignores an address with an exercise the catalog does not know', async () => {
    const { fixture, el } = await open('/treino/progresso?exercise=nao-existe', seedTwo);
    await eventually(fixture, () => expect(pressedChip(el)).toBe('Agachamento livre'));
  });

  it('shows an exercise with no record yet, when the sheet links to it before the first training', async () => {
    const { fixture, el } = await open('/treino/progresso?exercise=elevacao', seedTwo);
    await eventually(fixture, () =>
      expect(text(el)).toContain('Sem registro deste exercício ainda'),
    );

    // O exercício pedido aparece como chip (aberto), sem tirar os que têm histórico.
    expect(chips(el)).toEqual(['Agachamento livre', 'Supino reto com barra', 'Elevação lateral']);
    expect(pressedChip(el)).toBe('Elevação lateral');
    expect(text(el.querySelector('.sections .ui-row-sub'))).toBe('Sem registro ainda');
  });

  it('keeps the sections closed, each with its main number on the row', async () => {
    const { fixture, el } = await open('/treino/progresso?exercise=supino-reto', seedTwo);
    await eventually(fixture, () => expect(sectionTitles(el)).toHaveLength(4));

    expect(sectionTitles(el)).toEqual([
      'Recordes',
      'Semana',
      'Frequência',
      'Exportar e compartilhar',
    ]);
    const toggles = Array.from(el.querySelectorAll('.sections button.toggle'));
    expect(toggles.map((toggle) => toggle.getAttribute('aria-expanded'))).toEqual([
      'false',
      'false',
      'false',
      'false',
    ]);
    await eventually(fixture, () =>
      expect(text(el.querySelector('.sections .ui-row-sub'))).toBe(
        'Carga máx. 42,5 kg · 1RM 53,8 kg',
      ),
    );
    expect(el.querySelector('.sections table')).toBeNull();
    expect(el.querySelector('.sections .bars')).toBeNull();
  });

  it('changes the chart and the records when another exercise is tapped', async () => {
    const { fixture, el } = await open('/treino/progresso', seedTwo);
    await eventually(fixture, () => expect(text(el.querySelector('.value'))).toBe('76 kg'));

    chip(el, 'Supino reto com barra').click();

    await eventually(fixture, () => expect(text(el.querySelector('.value'))).toBe('53,8 kg'));
    expect(pressedChip(el)).toBe('Supino reto com barra');
    await eventually(fixture, () =>
      expect(text(el.querySelector('.sections .ui-row-sub'))).toBe(
        'Carga máx. 42,5 kg · 1RM 53,8 kg',
      ),
    );
    // A métrica e o período escolhidos continuam ao trocar de exercício.
    expect(el.querySelector('app-progress-seg button[aria-pressed="true"]')).not.toBeNull();
  });

  describe('with more exercises than chips', () => {
    const many = Array.from({ length: 8 }, (_, index) =>
      localExercise(`ex-${index + 1}`, { name: `Exercício ${index + 1}`, slug: `ex-${index + 1}` }),
    );
    // O 8 é o mais recente; o 1, o mais antigo.
    const seedMany = async (db: TrainingDb) => {
      for (let index = 1; index <= 8; index++) {
        await seedHistory(db, `ex-${index}`, [[90 + index, 20 + index, 10]]);
      }
    };

    it('shows the most recent ones and a chip for all the others', async () => {
      const { fixture, el } = await open('/treino/progresso', seedMany, many);
      await eventually(fixture, () => expect(chips(el)).toHaveLength(CHIP_LIMIT + 1));

      expect(chips(el)).toEqual([
        'Exercício 8',
        'Exercício 7',
        'Exercício 6',
        'Exercício 5',
        'Exercício 4',
        'Exercício 3',
        'Outro exercício',
      ]);
      expect(pressedChip(el)).toBe('Exercício 8');
    });

    it('lets the owner search every exercise with history and pick one that has no chip', async () => {
      const { fixture, el } = await open('/treino/progresso', seedMany, many);
      await eventually(fixture, () => expect(chips(el)).toHaveLength(CHIP_LIMIT + 1));

      chip(el, 'Outro exercício').click();
      fixture.detectChanges();
      const sheet = el.querySelector('app-exercise-history-sheet')!;
      expect(sheet).not.toBeNull();
      expect(text(sheet.querySelector('h2'))).toBe('Outro exercício');
      expect(sheet.querySelectorAll('.list button')).toHaveLength(8);

      const search = sheet.querySelector<HTMLInputElement>('input[type="search"]')!;
      search.value = 'exercicio 1';
      search.dispatchEvent(new Event('input'));
      fixture.detectChanges();
      const rows = Array.from(sheet.querySelectorAll('.list button'));
      expect(rows).toHaveLength(1);
      expect(text(rows[0].querySelector('.ui-row-title'))).toBe('Exercício 1');
      expect(text(rows[0].querySelector('.ui-row-sub'))).toMatch(/^último treino em \d{2}\/\d{2}$/);

      (rows[0] as HTMLButtonElement).click();
      await vi.waitFor(() => {
        fixture.detectChanges();
        expect(pressedChip(el)).toBe('Exercício 1');
      });
      // O escolhido ganha um chip, e os demais ficam onde estavam.
      expect(chips(el)).toEqual([
        'Exercício 8',
        'Exercício 7',
        'Exercício 6',
        'Exercício 5',
        'Exercício 4',
        'Exercício 3',
        'Exercício 1',
        'Outro exercício',
      ]);
    });

    it('says nothing was found when the search matches no exercise with history', async () => {
      const { fixture, el } = await open('/treino/progresso', seedMany, many);
      await eventually(fixture, () => expect(chips(el)).toHaveLength(CHIP_LIMIT + 1));

      chip(el, 'Outro exercício').click();
      fixture.detectChanges();
      const search = el.querySelector<HTMLInputElement>(
        'app-exercise-history-sheet input[type="search"]',
      )!;
      search.value = 'zzzz';
      search.dispatchEvent(new Event('input'));
      fixture.detectChanges();

      expect(text(el.querySelector('app-exercise-history-sheet .none'))).toBe(
        'Nenhum exercício com histórico achado.',
      );
    });
  });
});
