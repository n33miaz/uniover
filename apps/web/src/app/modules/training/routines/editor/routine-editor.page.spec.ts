import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { OfflineQueue } from '../../../../core/offline-queue/offline-queue';
import { RoutineRepository } from '../../data/routines/routine-repository';
import { catalog, eventually, item, saveRoutine, setupScreen } from '../../shell/screen-test-kit';
import { RoutineEditorPage } from './routine-editor.page';

describe('RoutineEditorPage', () => {
  async function open(url: string, seed = true) {
    const kit = await setupScreen([
      { path: 'treino/rotinas/nova', component: RoutineEditorPage },
      { path: 'treino/rotinas/:id', component: RoutineEditorPage },
      { path: '**', children: [] },
    ]);
    await kit.trainingDb.exercises.bulkPut(catalog());
    let routineId = '';
    if (seed) {
      const routine = await saveRoutine('Treino A', [
        item('i1', 'supino-reto', 0, { targetSets: 4, repMin: 6, repMax: 10, restSeconds: 120 }),
        item('i2', 'supino-inclinado', 1),
        item('i3', 'agachamento', 2),
      ]);
      routineId = routine.id;
    }
    const harness = await kit.harness();
    await harness.navigateByUrl(url.replace(':id', routineId), RoutineEditorPage);
    const el = harness.routeNativeElement as HTMLElement;
    return { ...kit, routineId, fixture: harness.fixture, el, router: TestBed.inject(Router) };
  }

  const text = (el: HTMLElement) => el.textContent?.replace(/\s+/g, ' ') ?? '';
  const names = (el: HTMLElement) =>
    Array.from(el.querySelectorAll('.items .item .name')).map((node) => node.textContent?.trim());
  const entry = (el: HTMLElement, index: number) =>
    el.querySelectorAll<HTMLElement>('.items .entry')[index];
  const byLabel = (el: HTMLElement, label: string) =>
    el.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!;
  const button = (el: HTMLElement, label: string) =>
    Array.from(el.querySelectorAll<HTMLButtonElement>('button')).find(
      (node) => node.textContent?.trim() === label,
    )!;
  /** A rotina abriu e os nomes dos exercícios já vieram do banco (antes disso as linhas trazem um nome provisório). */
  const loaded = (fixture: { detectChanges(): void }, el: HTMLElement) =>
    eventually(fixture, () =>
      expect(names(el)).toEqual([
        'Supino reto com barra',
        'Supino inclinado com halteres',
        'Agachamento livre',
      ]),
    );
  const setName = (el: HTMLElement, value: string) => {
    const input = el.querySelector<HTMLInputElement>('#routine-name')!;
    input.value = value;
    input.dispatchEvent(new Event('input'));
  };

  it('opens a routine: name, exercises in order, each with its goal in one line', async () => {
    const { fixture, el } = await open('/treino/rotinas/:id');
    await loaded(fixture, el);
    expect(el.querySelector('h2')?.textContent).toContain('Editar Rotina');
    expect(el.querySelector<HTMLInputElement>('#routine-name')!.value).toBe('Treino A');
    expect(names(el)).toEqual([
      'Supino reto com barra',
      'Supino inclinado com halteres',
      'Agachamento livre',
    ]);
    expect(entry(el, 0).querySelector('.meta')?.textContent).toBe('4 séries · 6–10 reps · 120 s');
    expect(entry(el, 1).querySelector('.meta')?.textContent).toBe('3 séries · 8–12 reps · 90 s');
  });

  it('does not show the tab-less editor with a missing routine, and says so', async () => {
    const { fixture, el } = await open('/treino/rotinas/nao-existe', false);
    await eventually(fixture, () => expect(text(el)).toContain('Esta rotina não existe mais'));
    expect(el.querySelector('form')).toBeNull();
  });

  describe('order', () => {
    it('has Subir and Descer on every exercise, off at the ends, each named after the exercise', async () => {
      const { fixture, el } = await open('/treino/rotinas/:id');
      await loaded(fixture, el);
      expect(byLabel(el, 'Subir Supino reto com barra').disabled).toBe(true);
      expect(byLabel(el, 'Descer Supino reto com barra').disabled).toBe(false);
      expect(byLabel(el, 'Descer Agachamento livre').disabled).toBe(true);
    });

    it('moves an exercise up and down by the buttons', async () => {
      const { fixture, el } = await open('/treino/rotinas/:id');
      await loaded(fixture, el);
      byLabel(el, 'Subir Agachamento livre').click();
      fixture.detectChanges();
      expect(names(el)).toEqual([
        'Supino reto com barra',
        'Agachamento livre',
        'Supino inclinado com halteres',
      ]);
      byLabel(el, 'Descer Supino reto com barra').click();
      fixture.detectChanges();
      expect(names(el)).toEqual([
        'Agachamento livre',
        'Supino reto com barra',
        'Supino inclinado com halteres',
      ]);
    });

    it('draws a handle on each row for the drag, hidden from the screen reader', async () => {
      const { fixture, el } = await open('/treino/rotinas/:id');
      await loaded(fixture, el);
      const grips = Array.from(el.querySelectorAll('.grip'));
      expect(grips).toHaveLength(3);
      expect(grips.every((grip) => grip.getAttribute('aria-hidden') === 'true')).toBe(true);
    });
  });

  describe('the goal of an exercise', () => {
    async function openFirst() {
      const kit = await open('/treino/rotinas/:id');
      await loaded(kit.fixture, kit.el);
      entry(kit.el, 0).querySelector<HTMLButtonElement>('.summary')!.click();
      kit.fixture.detectChanges();
      return kit;
    }

    it('opens the settings of one exercise at a time', async () => {
      const { fixture, el } = await openFirst();
      expect(el.querySelectorAll('.panel')).toHaveLength(1);
      expect(entry(el, 0).querySelector('.summary')?.getAttribute('aria-expanded')).toBe('true');
      entry(el, 1).querySelector<HTMLButtonElement>('.summary')!.click();
      fixture.detectChanges();
      expect(el.querySelectorAll('.panel')).toHaveLength(1);
      expect(entry(el, 1).querySelector('.panel')).not.toBeNull();
    });

    it('steps sets and repetitions by one and the rest by 15 s, and the summary follows', async () => {
      const { fixture, el } = await openFirst();
      byLabel(el, 'Aumentar séries').click();
      byLabel(el, 'Aumentar descanso').click();
      byLabel(el, 'Diminuir repetições mínimas').click();
      fixture.detectChanges();
      expect(entry(el, 0).querySelector('.meta')?.textContent).toBe('5 séries · 5–10 reps · 135 s');
    });

    it('joins an exercise with the next in a superset, and the last one cannot', async () => {
      const { fixture, el } = await openFirst();
      const toggle = entry(el, 0).querySelector<HTMLInputElement>('input[role="switch"]')!;
      expect(toggle.disabled).toBe(false);
      toggle.click();
      fixture.detectChanges();
      expect(entry(el, 0).querySelector('.link-note')?.textContent).toContain(
        'sem descanso entre o par',
      );
      entry(el, 2).querySelector<HTMLButtonElement>('.summary')!.click();
      fixture.detectChanges();
      expect(entry(el, 2).querySelector<HTMLInputElement>('input[role="switch"]')!.disabled).toBe(
        true,
      );
    });

    it('removes an exercise only after the confirmation', async () => {
      const { fixture, el } = await openFirst();
      button(el, 'Remover da Rotina').click();
      fixture.detectChanges();
      expect(text(el)).toContain('Remover este exercício da rotina?');
      expect(names(el)).toHaveLength(3);
      button(el, 'Manter').click();
      fixture.detectChanges();
      expect(el.querySelector('.panel .confirm')).toBeNull();
      button(el, 'Remover da Rotina').click();
      fixture.detectChanges();
      button(el, 'Remover').click();
      fixture.detectChanges();
      expect(names(el)).toEqual(['Supino inclinado com halteres', 'Agachamento livre']);
    });
  });

  describe('adding an exercise', () => {
    it('opens the catalog list in a sheet and adds the chosen one with 3 sets of 8 to 12 repetitions', async () => {
      const { fixture, el } = await open('/treino/rotinas/:id');
      await loaded(fixture, el);
      button(el, 'Adicionar Exercício').click();
      await eventually(fixture, () => expect(el.querySelector('dialog .ui-row')).not.toBeNull());
      const search = el.querySelector<HTMLInputElement>('dialog input[type="search"]')!;
      search.value = 'elevacao';
      search.dispatchEvent(new Event('input'));
      await eventually(fixture, () =>
        expect(el.querySelectorAll('dialog .ui-row')).toHaveLength(1),
      );
      el.querySelector<HTMLButtonElement>('dialog .ui-row')!.click();
      await eventually(fixture, () => expect(names(el)).toHaveLength(4));
      expect(names(el)[3]).toBe('Elevação lateral');
      expect(entry(el, 3).querySelector('.meta')?.textContent).toBe('3 séries · 8–12 reps · 90 s');
      expect(el.querySelector('dialog')).toBeNull();
    });
  });

  describe('saving', () => {
    it('saves the order and the goals, queues one write, and goes back to the list', async () => {
      const { fixture, el, router, routineId } = await open('/treino/rotinas/:id');
      await loaded(fixture, el);
      const before = (await TestBed.inject(OfflineQueue).items()).length;
      byLabel(el, 'Subir Agachamento livre').click();
      setName(el, 'Treino A · Pernas');
      fixture.detectChanges();
      button(el, 'Salvar Rotina').click();
      await vi.waitFor(() => expect(router.url).toBe('/treino/rotinas'), { timeout: 3000 });
      const saved = (await TestBed.inject(RoutineRepository).get(routineId))!;
      expect(saved.name).toBe('Treino A · Pernas');
      expect(saved.items.map((entryItem) => entryItem.exerciseId)).toEqual([
        'supino-reto',
        'agachamento',
        'supino-inclinado',
      ]);
      expect(await TestBed.inject(OfflineQueue).items()).toHaveLength(before + 1);
    });

    it('asks for a name', async () => {
      const { fixture, el, routineId } = await open('/treino/rotinas/:id');
      await loaded(fixture, el);
      setName(el, '   ');
      button(el, 'Salvar Rotina').click();
      await eventually(fixture, () => expect(text(el)).toContain('Dê um nome à rotina.'));
      expect(el.querySelector('#routine-name')?.getAttribute('aria-invalid')).toBe('true');
      expect((await TestBed.inject(RoutineRepository).get(routineId))?.name).toBe('Treino A');
    });

    it('shows the error on the exercise whose minimum repetitions pass the maximum, and does not save', async () => {
      const { fixture, el, routineId } = await open('/treino/rotinas/:id');
      await loaded(fixture, el);
      entry(el, 1).querySelector<HTMLButtonElement>('.summary')!.click();
      fixture.detectChanges();
      for (let n = 0; n < 6; n++) byLabel(el, 'Aumentar repetições mínimas').click();
      fixture.detectChanges();
      button(el, 'Salvar Rotina').click();
      await eventually(fixture, () =>
        expect(text(el)).toContain('A repetição mínima não pode passar da máxima.'),
      );
      expect(entry(el, 1).querySelector('.item')?.classList.contains('invalid')).toBe(true);
      const stored = (await TestBed.inject(RoutineRepository).get(routineId))!;
      expect(stored.items[1].repMin).toBe(8);
    });

    it('asks for at least one exercise', async () => {
      const { fixture, el } = await open('/treino/rotinas/nova', false);
      await eventually(fixture, () => expect(el.querySelector('form')).not.toBeNull());
      button(el, 'Salvar Rotina').click();
      await eventually(fixture, () =>
        expect(text(el)).toContain('Adicione pelo menos um exercício.'),
      );
    });
  });

  describe('a new routine', () => {
    it('suggests the next letter as the name', async () => {
      const { fixture, el } = await open('/treino/rotinas/nova');
      await eventually(fixture, () => expect(el.querySelector('form')).not.toBeNull());
      expect(el.querySelector('h2')?.textContent).toContain('Nova Rotina');
      expect(el.querySelector<HTMLInputElement>('#routine-name')!.value).toBe('Treino B');
    });

    it('comes with the exercise from its sheet, and the suggestion is not a change to confirm', async () => {
      const { fixture, el, router } = await open('/treino/rotinas/nova?exercicio=prancha');
      await eventually(fixture, () => expect(names(el)).toEqual(['Prancha isométrica']));
      const navigate = vi.spyOn(router, 'navigateByUrl');
      button(el, 'Cancelar').click();
      expect(el.querySelector('.ui-notice.warn')).toBeNull();
      expect(navigate).toHaveBeenCalledWith('/treino/rotinas', { replaceUrl: true });
    });

    it('creates the routine with the exercises chosen', async () => {
      const { fixture, el, router } = await open('/treino/rotinas/nova?exercicio=prancha');
      await eventually(fixture, () => expect(names(el)).toHaveLength(1));
      setName(el, 'Só o core');
      button(el, 'Salvar Rotina').click();
      await vi.waitFor(() => expect(router.url).toBe('/treino/rotinas'), { timeout: 3000 });
      const all = await TestBed.inject(RoutineRepository).listAll();
      const created = all.find((routine) => routine.name === 'Só o core')!;
      expect(created.items).toHaveLength(1);
      expect(created.items[0].exerciseId).toBe('prancha');
    });
  });

  describe('leaving', () => {
    it('asks before leaving with changes, and "Continuar Editando" keeps them', async () => {
      const { fixture, el, router } = await open('/treino/rotinas/:id');
      await loaded(fixture, el);
      byLabel(el, 'Subir Agachamento livre').click();
      const navigate = vi.spyOn(router, 'navigateByUrl');
      button(el, 'Cancelar').click();
      fixture.detectChanges();
      expect(text(el)).toContain('Sair sem salvar?');
      expect(navigate).not.toHaveBeenCalled();
      button(el, 'Continuar Editando').click();
      fixture.detectChanges();
      expect(names(el)[1]).toBe('Agachamento livre');
      button(el, 'Cancelar').click();
      fixture.detectChanges();
      button(el, 'Sair sem Salvar').click();
      expect(navigate).toHaveBeenCalledWith('/treino/rotinas', { replaceUrl: true });
    });

    it('leaves at once when nothing changed, and discards nothing in the queue', async () => {
      const { fixture, el, router } = await open('/treino/rotinas/:id');
      await loaded(fixture, el);
      const before = await TestBed.inject(OfflineQueue).items();
      const navigate = vi.spyOn(router, 'navigateByUrl');
      button(el, 'Cancelar').click();
      expect(navigate).toHaveBeenCalledWith('/treino/rotinas', { replaceUrl: true });
      expect(await TestBed.inject(OfflineQueue).items()).toEqual(before);
    });
  });

  describe('settings of the routine', () => {
    it('turns the routine off the sequence and saves it', async () => {
      const { fixture, el, router, routineId } = await open('/treino/rotinas/:id');
      await loaded(fixture, el);
      el.querySelector<HTMLInputElement>('.options input[role="switch"]')!.click();
      fixture.detectChanges();
      button(el, 'Salvar Rotina').click();
      await vi.waitFor(() => expect(router.url).toBe('/treino/rotinas'), { timeout: 3000 });
      expect((await TestBed.inject(RoutineRepository).get(routineId))?.active).toBe(false);
    });

    it('deletes the routine by a tombstone only after the confirmation', async () => {
      const { fixture, el, router, routineId } = await open('/treino/rotinas/:id');
      await loaded(fixture, el);
      button(el, 'Apagar Rotina').click();
      fixture.detectChanges();
      expect(text(el)).toContain('Apagar esta rotina?');
      expect(await TestBed.inject(RoutineRepository).get(routineId)).toBeDefined();
      button(el, 'Manter').click();
      fixture.detectChanges();
      button(el, 'Apagar Rotina').click();
      fixture.detectChanges();
      button(el, 'Apagar').click();
      await vi.waitFor(() => expect(router.url).toBe('/treino/rotinas'), { timeout: 3000 });
      expect(await TestBed.inject(RoutineRepository).get(routineId)).toBeUndefined();
      expect(
        (await TestBed.inject(RoutineRepository).readRaw(routineId))?.deletedAt,
      ).not.toBeNull();
    });
  });
});
