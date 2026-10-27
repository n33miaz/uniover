import { TestBed } from '@angular/core/testing';
import { OfflineQueue } from '../../../core/offline-queue/offline-queue';
import { FakeRoutineApi, seedCatalog } from '../data/routines/routine-data-test-kit';
import { RoutineApi } from '../data/routines/routine-api';
import { RoutineRepository } from '../data/routines/routine-repository';
import { eventually, setupScreen } from '../shell/screen-test-kit';
import { ProgramSuggestion } from './program-suggestion';

describe('ProgramSuggestion', () => {
  async function open(withDays = true) {
    const api = new FakeRoutineApi();
    const [duplo] = api.dto.items;
    api.dto = {
      items: [
        {
          ...duplo,
          routines: duplo.routines.map((day, index) => ({
            ...day,
            weekdays: withDays ? [index === 0 ? 1 : 3] : [],
          })),
        },
        {
          ...duplo,
          id: 'historical-ab',
          name: 'Histórico',
          routines: duplo.routines.map((day) => ({ ...day, weekdays: [1] })),
        },
      ],
    };
    const kit = await setupScreen(
      [{ path: 'treino', component: ProgramSuggestion }],
      [{ provide: RoutineApi, useValue: api }],
    );
    await seedCatalog(kit.trainingDb, ['supino', 'crucifixo', 'rosca', 'triceps']);
    const harness = await kit.harness();
    await harness.navigateByUrl('/treino', ProgramSuggestion);
    return { ...kit, api, fixture: harness.fixture, el: harness.routeNativeElement as HTMLElement };
  }

  const text = (el: HTMLElement) => el.textContent?.replace(/\s+/g, ' ') ?? '';

  it('offers the programs with their days, and never the historical one', async () => {
    const { fixture, el } = await open();

    await eventually(fixture, () => expect(el.querySelectorAll('.ui-row')).toHaveLength(1));
    expect(text(el)).toContain('Escolha seu programa');
    expect(el.querySelector('.ui-row-title')?.textContent?.trim()).toBe('Duplo');
    expect(el.querySelector('.ui-row-sub')?.textContent?.trim()).toBe('Seg Peito · Qua Braços');
  });

  it('one tap chooses: the routines are saved on the device and the choice waits in the queue', async () => {
    const { fixture, el } = await open();
    await eventually(fixture, () => expect(el.querySelectorAll('.ui-row')).toHaveLength(1));

    el.querySelector<HTMLButtonElement>('.ui-row')!.click();

    await vi.waitFor(async () =>
      expect(await TestBed.inject(RoutineRepository).activeProgramId()).toBe('duplo'),
    );
    // A fila recebe os pedidos depois de o programa ficar ativo: sob carga, a terceira entrada chega um pouco depois.
    await vi.waitFor(async () =>
      expect(await TestBed.inject(OfflineQueue).items()).toHaveLength(3),
    );
  });

  it('shows nothing when no template declares its days', async () => {
    const { fixture, el } = await open(false);

    await eventually(fixture, () => expect(el.querySelector('section')).toBeNull());
  });
});
