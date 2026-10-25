import { Location } from '@angular/common';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { TrainingSync } from '../../data/sync/training-sync';
import { localExercise } from '../../data/sync/training-test-kit';
import type { LocalSession, LocalSet } from '../../data/sessions/session';
import { catalog, eventually, setupScreen } from '../../shell/screen-test-kit';
import { ExerciseLibraryPage, PAGE_SIZE } from './library.page';

const AT = 1_760_000_000_000;

describe('ExerciseLibraryPage', () => {
  async function open(url = '/treino/exercicios', rows = catalog()) {
    const kit = await setupScreen([{ path: 'treino/exercicios', component: ExerciseLibraryPage }]);
    await kit.trainingDb.exercises.bulkPut(rows);
    const harness = await kit.harness();
    await harness.navigateByUrl(url, ExerciseLibraryPage);
    const el = harness.routeNativeElement as HTMLElement;
    return { ...kit, fixture: harness.fixture, el, router: TestBed.inject(Router) };
  }

  /** O endereço do navegador (a tela o escreve sem navegar pelo roteador). */
  const path = () => TestBed.inject(Location).path();
  const names = (el: HTMLElement) =>
    Array.from(el.querySelectorAll('.list .name')).map((node) => node.textContent?.trim());
  const rows = (el: HTMLElement) =>
    Array.from(el.querySelectorAll<HTMLAnchorElement>('.list .ui-row'));
  const count = (el: HTMLElement) => el.querySelector('.number')?.textContent?.trim();
  const search = (el: HTMLElement) => el.querySelector<HTMLInputElement>('input[type="search"]')!;
  const chip = (el: HTMLElement, label: string) =>
    Array.from(el.querySelectorAll<HTMLButtonElement>('app-training-chips .chip')).find(
      (button) => button.textContent?.trim() === label,
    )!;

  function type(el: HTMLElement, value: string) {
    const input = search(el);
    input.value = value;
    input.dispatchEvent(new Event('input'));
  }

  it('lists the catalog by name, with the group, the equipment and how many there are', async () => {
    const { fixture, el } = await open();
    await eventually(fixture, () => expect(names(el)).toHaveLength(5));
    expect(names(el)).toEqual([
      'Agachamento livre',
      'Elevação lateral',
      'Prancha isométrica',
      'Supino inclinado com halteres',
      'Supino reto com barra',
    ]);
    expect(count(el)).toBe('5 exercícios');
    expect(el.textContent).not.toContain('Catálogo em português');
    expect(rows(el)[4].querySelector('.sub')?.textContent).toContain('Peito · Barra');
  });

  it('links each row to the exercise sheet', async () => {
    const { fixture, el } = await open();
    await eventually(fixture, () => expect(rows(el)).toHaveLength(5));
    expect(rows(el)[4].getAttribute('href')).toBe('/treino/exercicios/supino-reto');
  });

  it('finds an exercise without accent and without case, and writes the search in the address', async () => {
    const { fixture, el } = await open();
    await eventually(fixture, () => expect(rows(el)).toHaveLength(5));
    type(el, 'ELEVACAO');
    await eventually(fixture, () => expect(names(el)).toEqual(['Elevação lateral']));
    expect(count(el)).toBe('1 exercício achado');
    await vi.waitFor(() => expect(path()).toContain('q=ELEVACAO'), { timeout: 2000 });
  });

  it('combines the group and the equipment, both in the address', async () => {
    const { fixture, el } = await open();
    await eventually(fixture, () => expect(rows(el)).toHaveLength(5));
    chip(el, 'Peito').click();
    await eventually(fixture, () => expect(rows(el)).toHaveLength(2));
    expect(chip(el, 'Peito').getAttribute('aria-pressed')).toBe('true');

    el.querySelector<HTMLButtonElement>('button.filters')!.click();
    fixture.detectChanges();
    chip(el, 'Halteres').click();
    await eventually(fixture, () => expect(names(el)).toEqual(['Supino inclinado com halteres']));
    await vi.waitFor(() => expect(path()).toMatch(/group=chest.*equipment=dumbbell/), {
      timeout: 2000,
    });
    expect(count(el)).toBe('1 exercício achado');
  });

  it('opens already filtered when the address has filters, and fills the search box', async () => {
    const { fixture, el } = await open('/treino/exercicios?q=supino&group=chest&equipment=barbell');
    await eventually(fixture, () => expect(names(el)).toEqual(['Supino reto com barra']));
    expect(search(el).value).toBe('supino');
    expect(chip(el, 'Peito').getAttribute('aria-pressed')).toBe('true');
    expect(el.querySelector('#equipment-filter')).not.toBeNull();
    expect(chip(el, 'Barra').getAttribute('aria-pressed')).toBe('true');
  });

  it('shows a muscle from the body map as a chip that one touch takes away', async () => {
    const { fixture, el } = await open('/treino/exercicios?muscle=shoulders');
    await eventually(fixture, () => expect(names(el)).toEqual(['Elevação lateral']));
    const remove = el.querySelector<HTMLButtonElement>('.muscle-chip')!;
    expect(remove.textContent).toContain('Músculo: Ombros');
    remove.click();
    await eventually(fixture, () => expect(rows(el)).toHaveLength(5));
    expect(el.querySelector('.muscle-chip')).toBeNull();
    await vi.waitFor(() => expect(path()).not.toContain('muscle'), { timeout: 2000 });
  });

  it('follows the address when it changes from outside (the back button)', async () => {
    const { fixture, el, router } = await open();
    await eventually(fixture, () => expect(rows(el)).toHaveLength(5));
    await router.navigateByUrl('/treino/exercicios?q=agachamento');
    await eventually(fixture, () => expect(names(el)).toEqual(['Agachamento livre']));
    expect(search(el).value).toBe('agachamento');
  });

  it('reads "seu último" only for the rows on screen, and says "sem registro" for the rest', async () => {
    const kit = await setupScreen([{ path: 'treino/exercicios', component: ExerciseLibraryPage }]);
    await kit.trainingDb.exercises.bulkPut(catalog());
    const session: LocalSession = {
      id: 's1',
      routineId: null,
      startedAt: AT,
      finishedAt: AT + 3_000_000,
      note: '',
      feeling: null,
      deviceId: 'd',
      updatedAt: AT,
      clientUpdatedAt: AT,
      deletedAt: null,
    };
    const set = (id: string, weightKg: number, reps: number, position: number): LocalSet => ({
      id,
      sessionId: 's1',
      exerciseId: 'supino-reto',
      position,
      setType: 'work',
      weightKg,
      reps,
      durationS: null,
      rir: null,
      rpe: null,
      note: '',
      completedAt: AT + position * 60_000,
      updatedAt: AT,
      clientUpdatedAt: AT,
      deletedAt: null,
    });
    await kit.trainingDb.sessions.put(session);
    await kit.trainingDb.sets.bulkPut([set('a', 40, 10, 1), set('b', 42.5, 8, 2)]);
    const harness = await kit.harness();
    await harness.navigateByUrl('/treino/exercicios', ExerciseLibraryPage);
    const el = harness.routeNativeElement as HTMLElement;
    await eventually(harness.fixture, () =>
      expect(rows(el)[4].querySelector('.sub')?.textContent).toContain('seu último: 42,5 kg × 8'),
    );
    expect(rows(el)[0].querySelector('.sub')?.textContent).toContain('sem registro');
  });

  it('shows 50 rows at a time and the rest after "Mostrar mais"', async () => {
    const extra = Array.from({ length: 70 }, (_, n) =>
      localExercise(`extra-${n}`, { name: `Extra ${String(n).padStart(2, '0')}` }),
    );
    const { fixture, el } = await open('/treino/exercicios', [...catalog(), ...extra]);
    await eventually(fixture, () => expect(rows(el)).toHaveLength(PAGE_SIZE));
    const more = el.querySelector<HTMLButtonElement>('.more')!;
    expect(more.textContent).toContain('Mostrar mais (25)');
    more.click();
    await eventually(fixture, () => expect(rows(el)).toHaveLength(75));
    expect(el.querySelector('.more')).toBeNull();
  });

  it('explains an empty catalog and offers to download it again', async () => {
    const { fixture, el } = await open('/treino/exercicios', []);
    await eventually(fixture, () =>
      expect(el.textContent).toContain('O catálogo ainda não chegou'),
    );
    const pull = vi.spyOn(TestBed.inject(TrainingSync), 'pullNow').mockResolvedValue();
    const retry = Array.from(el.querySelectorAll<HTMLButtonElement>('button')).find((button) =>
      button.textContent?.includes('Tentar baixar'),
    )!;
    retry.click();
    expect(pull).toHaveBeenCalledOnce();
  });

  it('says nothing was found, and offers to clear the filters or to create the exercise from the search', async () => {
    const { fixture, el } = await open();
    await eventually(fixture, () => expect(rows(el)).toHaveLength(5));
    type(el, 'zzzz');
    await eventually(fixture, () => expect(el.textContent).toContain('Nenhum exercício achado'));
    const create = el.querySelector<HTMLAnchorElement>('.empty a')!;
    expect(create.textContent).toContain('Criar “zzzz”');
    expect(create.getAttribute('href')).toBe('/treino/exercicios/novo?nome=zzzz');
    const clear = Array.from(el.querySelectorAll<HTMLButtonElement>('.empty button')).find(
      (button) => button.textContent?.includes('Limpar filtros'),
    )!;
    clear.click();
    await eventually(fixture, () => expect(rows(el)).toHaveLength(5));
    expect(search(el).value).toBe('');
  });

  it('announces the count politely, and every control has a name', async () => {
    const { fixture, el } = await open();
    await eventually(fixture, () => expect(rows(el)).toHaveLength(5));
    expect(el.querySelector('.number')?.getAttribute('role')).toBe('status');
    expect(search(el).labels?.[0]?.textContent).toContain('Buscar exercício');
    expect(el.querySelector('button.filters')?.getAttribute('aria-label')).toBe('Equipamento');
    expect(el.querySelector('a[href$="/novo"]')?.getAttribute('aria-label')).toBe('Novo exercício');
    expect(el.querySelector('a[href$="/mapa"]')?.getAttribute('aria-label')).toBe('Mapa do corpo');
  });
});
