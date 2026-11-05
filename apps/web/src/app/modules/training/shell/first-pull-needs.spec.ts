import { Type } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { deferred } from '../../../core/offline-queue/queue-test-kit';
import { BodyPage } from '../body/body.page';
import { TrainingSync } from '../data/sync/training-sync';
import { routineDto } from '../data/routines/routine-data-test-kit';
import { exerciseDto, setupTraining } from '../data/sync/training-test-kit';
import { ProgressPage } from '../progress/progress.page';
import { RoutineEditorPage } from '../routines/editor/routine-editor.page';
import { RoutinesListPage } from '../routines/routines-list.page';
import { TodayPage } from '../today/today.page';

/**
 * O primeiro puxar de um aparelho novo não deve fazer Rotinas e Corpo esperarem o catálogo de exercícios (a maior resposta do
 * servidor), que a passada puxa depois do que a tela aberta pediu. Progresso lê o catálogo: sem ele a lista de exercícios
 * com histórico ficaria vazia, então ele espera. Hoje espera o que lê para decidir (rotinas, programa, treinos, séries e o
 * catálogo) e o editor de rotina, a rotina e o catálogo; nenhum espera a passada inteira.
 */
const api = (name: string) => `/api/v1/training/${name}`;

const io = () => new Promise<void>((resolve) => setTimeout(resolve, 20));

async function settle(fixture: ComponentFixture<unknown>, rounds = 12): Promise<void> {
  for (let round = 0; round < rounds; round++) {
    await io();
    fixture.detectChanges();
  }
}

const hasSkeleton = (tag: string) => (el: HTMLElement) => el.querySelector(tag) !== null;

/** Aparelho novo, com rede e sessão; o catálogo (`exercises`) só responde quando o teste mandar. */
function openWithSlowCatalog(page: Type<unknown>, exercisesSlot: number) {
  const kit = setupTraining();
  TestBed.configureTestingModule({ providers: [provideRouter([])] });
  kit.pause();
  const catalogGate = deferred();
  // O roteiro é uma fila só para todos os caminhos: as páginas vazias são o padrão, e o catálogo cai no lugar dado.
  kit.pull.script = Array.from({ length: exercisesSlot }, (_, i) =>
    i === exercisesSlot - 1
      ? () => catalogGate.promise.then(() => ({ items: [], nextCursor: null }))
      : { items: [], nextCursor: null },
  );
  const fixture = TestBed.createComponent(page);
  fixture.detectChanges();
  const sync = TestBed.inject(TrainingSync);
  void sync.start();
  return { kit, fixture, sync, catalogGate, el: fixture.nativeElement as HTMLElement };
}

// A primeira abertura carrega as telas pelo import dinâmico: numa máquina carregada passa dos 5 s do padrão.
describe('the first pull waits only for what the screen reads', { timeout: 20_000 }, () => {
  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it('Rotinas pulls routines, program and sessions first and shows its state while the catalog is still pending', async () => {
    const { kit, fixture, sync, catalogGate, el } = openWithSlowCatalog(RoutinesListPage, 4);

    await vi.waitFor(() => expect(kit.pull.calls).toHaveLength(4), { timeout: 5000 });
    await settle(fixture);

    expect(kit.pull.calls.map((call) => call.path)).toEqual([
      api('routines'),
      api('program'),
      api('sessions'),
      api('exercises'),
    ]);
    expect(sync.firstPassSettled()).toBe(false);
    expect(sync.resourcesPulled(['exercises'])).toBe(false);
    expect(hasSkeleton('app-routines-list-skeleton')(el)).toBe(false);
    expect(el.textContent).toContain('Sem Rotinas Ainda');

    catalogGate.open();
    await vi.waitFor(() => expect(sync.firstPassSettled()).toBe(true), { timeout: 5000 });
  });

  it('Corpo pulls its measurements, profile and goals first and leaves the skeleton while the catalog is still pending', async () => {
    const { kit, fixture, sync, catalogGate, el } = openWithSlowCatalog(BodyPage, 4);

    await vi.waitFor(() => expect(kit.pull.calls).toHaveLength(4), { timeout: 5000 });
    await settle(fixture);

    expect(kit.pull.calls.map((call) => call.path)).toEqual([
      api('body/entries'),
      api('body/profile'),
      api('goals'),
      api('exercises'),
    ]);
    expect(sync.firstPassSettled()).toBe(false);
    expect(hasSkeleton('app-body-skeleton')(el)).toBe(false);

    catalogGate.open();
    await vi.waitFor(() => expect(sync.firstPassSettled()).toBe(true), { timeout: 5000 });
  });

  it('Progresso keeps the skeleton until the catalog arrived, because the exercise names come from it', async () => {
    const { kit, fixture, sync, catalogGate, el } = openWithSlowCatalog(ProgressPage, 4);

    await vi.waitFor(() => expect(kit.pull.calls).toHaveLength(4), { timeout: 5000 });
    await settle(fixture);

    expect(kit.pull.calls.map((call) => call.path)).toEqual([
      api('sessions'),
      api('sets'),
      api('goals'),
      api('exercises'),
    ]);
    expect(sync.firstPassSettled()).toBe(false);
    expect(hasSkeleton('app-progress-skeleton')(el)).toBe(true);

    catalogGate.open();
    await vi.waitFor(() => expect(sync.resourcesPulled(['exercises'])).toBe(true), {
      timeout: 5000,
    });
    await settle(fixture);
    expect(hasSkeleton('app-progress-skeleton')(el)).toBe(false);
  });

  it('Hoje pulls what it reads to decide, the catalog last, and keeps its skeleton until the catalog arrived', async () => {
    const { kit, fixture, sync, catalogGate, el } = openWithSlowCatalog(TodayPage, 5);

    await vi.waitFor(() => expect(kit.pull.calls).toHaveLength(5), { timeout: 5000 });
    await settle(fixture, 6);

    expect(kit.pull.calls.map((call) => call.path)).toEqual([
      api('routines'),
      api('program'),
      api('sessions'),
      api('sets'),
      api('exercises'),
    ]);
    expect(sync.firstPassSettled()).toBe(false);
    expect(sync.resourcesPulled(['routines', 'program', 'sessions', 'sets'])).toBe(true);
    expect(sync.resourcesPulled(['exercises'])).toBe(false);
    expect(
      el.querySelector('app-today-skeleton') !== null ||
        (el.textContent ?? '').includes('Baixando o catálogo…'),
    ).toBe(true);
    expect(el.textContent).not.toContain('Sem Rotinas Ainda');

    catalogGate.open();
    await vi.waitFor(() => expect(sync.resourcesPulled(['exercises'])).toBe(true), {
      timeout: 5000,
    });
    await settle(fixture);
    expect(el.textContent).not.toContain('Baixando o catálogo…');
  });

  it('the routine editor pulls the routine and then the catalog, and never says the routine or its exercises are gone while they come', async () => {
    const kit = setupTraining();
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        {
          provide: ActivatedRoute,
          useValue: {
            snapshot: {
              paramMap: convertToParamMap({ id: 'r1' }),
              queryParamMap: convertToParamMap({}),
            },
          },
        },
      ],
    });
    kit.pause();
    const routineGate = deferred();
    const catalogGate = deferred();
    // Um aparelho novo: o catálogo (a maior resposta) viria antes da rotina na ordem de registro.
    kit.pull.script = [
      () =>
        routineGate.promise.then(() => ({
          items: [
            routineDto('r1', {
              name: 'Treino A',
              items: [
                {
                  id: 'i1',
                  exerciseId: 'supino',
                  position: 0,
                  targetSets: 3,
                  repMin: 8,
                  repMax: 12,
                  restSeconds: 90,
                  supersetGroup: null,
                  note: null,
                },
              ],
            }),
          ],
          nextCursor: null,
        })),
      () =>
        catalogGate.promise.then(() => ({
          items: [exerciseDto('supino', { name: 'Supino reto' })],
          nextCursor: null,
        })),
    ];
    const fixture = TestBed.createComponent(RoutineEditorPage);
    fixture.detectChanges();
    const sync = TestBed.inject(TrainingSync);
    void sync.start();
    const el = fixture.nativeElement as HTMLElement;
    const rowName = () => el.querySelector('.items .item .name')?.textContent?.trim();

    await vi.waitFor(() => expect(kit.pull.calls).toHaveLength(1), { timeout: 5000 });
    await settle(fixture, 4);
    expect(kit.pull.calls[0].path).toBe(api('routines'));
    expect(hasSkeleton('app-training-form-skeleton')(el)).toBe(true);
    expect(el.textContent).not.toContain('Esta rotina não existe mais');

    routineGate.open();
    await vi.waitFor(() => expect(kit.pull.calls).toHaveLength(2), { timeout: 5000 });
    await vi.waitFor(() => expect(rowName()).toBeDefined(), { timeout: 5000 });
    fixture.detectChanges();
    expect(kit.pull.calls[1].path).toBe(api('exercises'));
    expect(el.querySelector<HTMLInputElement>('#routine-name')?.value).toBe('Treino A');
    expect(el.textContent).not.toContain('Esta rotina não existe mais');
    expect(el.textContent).not.toContain('Exercício que não existe mais');

    catalogGate.open();
    await vi.waitFor(
      () => {
        fixture.detectChanges();
        expect(rowName()).toBe('Supino reto');
      },
      { timeout: 5000 },
    );
  });
});
