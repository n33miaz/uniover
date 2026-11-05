import { Type } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { deferred } from '../../../core/offline-queue/queue-test-kit';
import { BodyPage } from '../body/body.page';
import { TrainingSync } from '../data/sync/training-sync';
import { setupTraining } from '../data/sync/training-test-kit';
import { ProgressPage } from '../progress/progress.page';
import { RoutinesListPage } from '../routines/routines-list.page';
import { TodayPage } from '../today/today.page';

/**
 * O primeiro puxar de um aparelho novo não deve fazer Rotinas e Corpo esperarem o catálogo de exercícios (a maior resposta do
 * servidor), que a passada puxa depois do que a tela aberta pediu. Progresso lê o catálogo: sem ele a lista de exercícios
 * com histórico ficaria vazia, então ele espera. Hoje não pede nada e segue esperando a passada inteira.
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

describe('the first pull waits only for what the screen reads', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it('Rotinas pulls routines, program and sessions first and shows its state while the catalog is still pending', async () => {
    const { kit, fixture, sync, catalogGate, el } = openWithSlowCatalog(RoutinesListPage, 4);

    await vi.waitFor(() => expect(kit.pull.calls).toHaveLength(4));
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
    await vi.waitFor(() => expect(sync.firstPassSettled()).toBe(true));
  });

  it('Corpo pulls its measurements, profile and goals first and leaves the skeleton while the catalog is still pending', async () => {
    const { kit, fixture, sync, catalogGate, el } = openWithSlowCatalog(BodyPage, 4);

    await vi.waitFor(() => expect(kit.pull.calls).toHaveLength(4));
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
    await vi.waitFor(() => expect(sync.firstPassSettled()).toBe(true));
  });

  it('Progresso keeps the skeleton until the catalog arrived, because the exercise names come from it', async () => {
    const { kit, fixture, sync, catalogGate, el } = openWithSlowCatalog(ProgressPage, 4);

    await vi.waitFor(() => expect(kit.pull.calls).toHaveLength(4));
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
    await vi.waitFor(() => expect(sync.resourcesPulled(['exercises'])).toBe(true));
    await settle(fixture);
    expect(hasSkeleton('app-progress-skeleton')(el)).toBe(false);
  });

  it('Hoje does not ask for anything and keeps waiting for the whole pass, catalog first', async () => {
    const { kit, fixture, sync, catalogGate, el } = openWithSlowCatalog(TodayPage, 1);

    await vi.waitFor(() => expect(kit.pull.calls).toHaveLength(1));
    await settle(fixture, 6);

    expect(kit.pull.calls[0].path).toBe(api('exercises'));
    expect(sync.firstPassSettled()).toBe(false);
    expect(
      el.querySelector('app-today-skeleton') !== null ||
        (el.textContent ?? '').includes('Baixando o catálogo…'),
    ).toBe(true);

    catalogGate.open();
    await vi.waitFor(() => expect(sync.firstPassSettled()).toBe(true));
  });
});
