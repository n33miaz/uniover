import { Location } from '@angular/common';
import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { MUSCLE_IDS } from '../../domain/taxonomy';
import { localExercise } from '../../data/sync/training-test-kit';
import {
  localSet,
  seedExerciseCatalog,
  session,
  sets,
} from '../../data/progress/progress-data-test-kit';
import { at } from '../../domain/progress/progress-test-kit';
import { catalog, eventually, setupScreen } from '../../shell/screen-test-kit';
import { BodyMapPage } from './body-map.page';

@Component({ selector: 'app-library-stub', template: '' })
class LibraryStub {}

describe('BodyMapPage', () => {
  let scrollIntoView: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    // O jsdom não implementa a rolagem até um elemento.
    scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView as unknown as Element['scrollIntoView'];
  });

  async function open(url = '/treino/exercicios/mapa', rows = catalog()) {
    const kit = await setupScreen([
      { path: 'treino/exercicios/mapa', component: BodyMapPage },
      { path: 'treino/exercicios', component: LibraryStub },
    ]);
    // Quarta-feira de uma semana com treino (segunda 12/10 a domingo 18/10).
    kit.runtime.time = at('2026-10-14', 12);
    await kit.trainingDb.exercises.bulkPut(rows);
    return { ...kit, ...(await mount(kit, url)) };
  }

  async function mount(kit: Awaited<ReturnType<typeof setupScreen>>, url: string) {
    const harness = await kit.harness();
    await harness.navigateByUrl(url, BodyMapPage);
    const el = harness.routeNativeElement as HTMLElement;
    return { fixture: harness.fixture, el, router: TestBed.inject(Router) };
  }

  const path = () => TestBed.inject(Location).path();
  const zone = (el: HTMLElement, muscle: string) =>
    el.querySelector<SVGGElement>(`.figure .zone[data-muscle="${muscle}"]`);
  const zoneMuscles = (el: HTMLElement) =>
    Array.from(el.querySelectorAll<SVGGElement>('.figure .zone')).map((g) => g.dataset['muscle']);
  const chip = (el: HTMLElement, muscle: string) =>
    el.querySelector<HTMLButtonElement>(`app-muscle-list .chip[data-muscle="${muscle}"]`)!;
  /** O nome do botão da lista, como o leitor de tela o monta do conteúdo ("Peitoral 2 exercícios"). */
  const chipName = (el: HTMLElement, muscle: string) =>
    chip(el, muscle).textContent?.replace(/\s+/g, ' ').trim();
  const panel = (el: HTMLElement) => el.querySelector('app-body-panel');
  const faceButton = (el: HTMLElement, label: string) =>
    Array.from(el.querySelectorAll<HTMLButtonElement>('.faces button')).find(
      (button) => button.textContent?.trim() === label,
    )!;

  it('shows the front of the body, with one zone per muscle and the exercise count in its label', async () => {
    const { fixture, el } = await open();
    await eventually(fixture, () => expect(zone(el, 'chest')).not.toBeNull());
    expect(zoneMuscles(el)).toEqual([
      'neck',
      'shoulders',
      'chest',
      'biceps',
      'abdominals',
      'forearms',
      'quadriceps',
      'adductors',
      'calves',
    ]);
    const chest = zone(el, 'chest')!;
    expect(chest.getAttribute('role')).toBe('button');
    expect(chest.getAttribute('tabindex')).toBe('0');
    expect(chest.getAttribute('aria-pressed')).toBe('false');
    expect(chest.getAttribute('aria-label')).toBe(
      'Peitoral, 2 exercícios, Nenhuma série nesta semana',
    );
    expect(zone(el, 'biceps')!.getAttribute('aria-label')).toBe(
      'Bíceps, 0 exercícios, Nenhuma série nesta semana',
    );
    expect(el.querySelector('.figure')!.getAttribute('aria-label')).toBe('Corpo, de frente');
  });

  it('starts neutral when nothing was trained this week: no accent, no alarm', async () => {
    const { fixture, el } = await open();
    await eventually(fixture, () => expect(zone(el, 'chest')).not.toBeNull());
    for (const g of Array.from(el.querySelectorAll<SVGGElement>('.figure .zone'))) {
      expect(g.dataset['level']).toBe('0');
    }
    expect(panel(el)).toBeNull();
    expect(el.querySelector('.hint')?.textContent).toContain('Toque num músculo');
  });

  it('opens the panel with the exercises of the muscle and a link to the list already filtered', async () => {
    const { fixture, el } = await open();
    await eventually(fixture, () => expect(zone(el, 'chest')).not.toBeNull());
    zone(el, 'chest')!.dispatchEvent(new Event('click'));
    await eventually(fixture, () => expect(panel(el)).not.toBeNull());

    expect(el.querySelector('app-body-panel h3')?.textContent?.trim()).toBe('Peitoral');
    const rows = Array.from(el.querySelectorAll('app-body-panel .row-name')).map((n) =>
      n.textContent?.trim(),
    );
    expect(rows).toEqual(['Supino inclinado com halteres', 'Supino reto com barra']);
    expect(el.querySelector('app-body-panel .foot a')!.textContent?.trim()).toBe('Ver todos (2)');
    expect(el.querySelector('app-body-panel .foot a')!.getAttribute('href')).toBe(
      '/treino/exercicios?muscle=chest',
    );
    expect(zone(el, 'chest')!.getAttribute('aria-pressed')).toBe('true');
    expect(zone(el, 'chest')!.classList.contains('on')).toBe(true);
    expect(el.querySelector('.hint')).toBeNull();
    expect(path()).toContain('muscle=chest');
  });

  it('scrolls the least that shows the panel, whether the muscle came from the figure or from the list', async () => {
    const { fixture, el } = await open();
    await eventually(fixture, () => expect(zone(el, 'chest')).not.toBeNull());
    expect(scrollIntoView).not.toHaveBeenCalled();
    zone(el, 'chest')!.dispatchEvent(new Event('click'));
    await vi.waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(1));
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest', behavior: 'smooth' });
    chip(el, 'quadriceps').click();
    await vi.waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(2));
    // Fechar o painel não rola para lugar nenhum.
    chip(el, 'quadriceps').click();
    await eventually(fixture, () => expect(panel(el)).toBeNull());
    expect(scrollIntoView).toHaveBeenCalledTimes(2);
  });

  it('links each row to the sheet of the exercise', async () => {
    const { fixture, el } = await open();
    await eventually(fixture, () => expect(zone(el, 'chest')).not.toBeNull());
    zone(el, 'chest')!.dispatchEvent(new Event('click'));
    await eventually(fixture, () => expect(panel(el)).not.toBeNull());
    const hrefs = Array.from(el.querySelectorAll('app-body-panel .ui-row')).map((a) =>
      a.getAttribute('href'),
    );
    expect(hrefs).toEqual([
      '/treino/exercicios/supino-inclinado',
      '/treino/exercicios/supino-reto',
    ]);
  });

  it('lists only the first three exercises and counts all of them on the button', async () => {
    const rows = [
      ...catalog(),
      localExercise('crucifixo', { name: 'Crucifixo reto', primaryMuscles: ['chest'] }),
      localExercise('flexao', { name: 'Flexão de braço', primaryMuscles: ['chest'] }),
    ];
    const { fixture, el } = await open('/treino/exercicios/mapa?muscle=chest', rows);
    await eventually(fixture, () => expect(panel(el)).not.toBeNull());
    expect(el.querySelectorAll('app-body-panel .ui-row')).toHaveLength(3);
    expect(el.querySelector('app-body-panel .foot a')!.textContent?.trim()).toBe('Ver todos (4)');
  });

  it('chooses a zone with Enter and with Space, and keeps the page from scrolling on Space', async () => {
    const { fixture, el } = await open();
    await eventually(fixture, () => expect(zone(el, 'chest')).not.toBeNull());
    zone(el, 'chest')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    await eventually(fixture, () =>
      expect(zone(el, 'chest')!.getAttribute('aria-pressed')).toBe('true'),
    );

    const space = new KeyboardEvent('keydown', { key: ' ', cancelable: true });
    zone(el, 'quadriceps')!.dispatchEvent(space);
    await eventually(fixture, () =>
      expect(zone(el, 'quadriceps')!.getAttribute('aria-pressed')).toBe('true'),
    );
    expect(space.defaultPrevented).toBe(true);
    // Um músculo por vez.
    expect(zone(el, 'chest')!.getAttribute('aria-pressed')).toBe('false');
    expect(el.querySelector('app-body-panel h3')?.textContent?.trim()).toBe('Quadríceps');
  });

  it('closes the panel when the open muscle is chosen again', async () => {
    const { fixture, el } = await open();
    await eventually(fixture, () => expect(zone(el, 'chest')).not.toBeNull());
    zone(el, 'chest')!.dispatchEvent(new Event('click'));
    await eventually(fixture, () => expect(panel(el)).not.toBeNull());
    zone(el, 'chest')!.dispatchEvent(new Event('click'));
    await eventually(fixture, () => expect(panel(el)).toBeNull());
    expect(path()).not.toContain('muscle');
  });

  it('switches to the back, keeps it in the address and draws the back zones', async () => {
    const { fixture, el } = await open();
    await eventually(fixture, () => expect(zone(el, 'chest')).not.toBeNull());
    expect(faceButton(el, 'Frente').getAttribute('aria-pressed')).toBe('true');
    faceButton(el, 'Costas').click();
    await eventually(fixture, () => expect(zone(el, 'lats')).not.toBeNull());
    expect(faceButton(el, 'Costas').getAttribute('aria-pressed')).toBe('true');
    expect(faceButton(el, 'Frente').getAttribute('aria-pressed')).toBe('false');
    expect(zoneMuscles(el)).toEqual([
      'traps',
      'shoulders',
      'triceps',
      'lats',
      'forearms',
      'middle_back',
      'lower_back',
      'glutes',
      'abductors',
      'hamstrings',
      'calves',
    ]);
    expect(el.querySelector('.figure')!.getAttribute('aria-label')).toBe('Corpo, de costas');
    expect(path()).toContain('face=back');
    faceButton(el, 'Frente').click();
    await eventually(fixture, () => expect(zone(el, 'chest')).not.toBeNull());
    expect(path()).not.toContain('face');
  });

  it('keeps the open muscle when the face changes', async () => {
    const { fixture, el } = await open('/treino/exercicios/mapa?muscle=shoulders');
    await eventually(fixture, () => expect(panel(el)).not.toBeNull());
    faceButton(el, 'Costas').click();
    await eventually(fixture, () => expect(zone(el, 'shoulders')).not.toBeNull());
    expect(zone(el, 'shoulders')!.getAttribute('aria-pressed')).toBe('true');
    expect(panel(el)).not.toBeNull();
  });

  it('opens on the face and the muscle that the address asks for', async () => {
    const { fixture, el } = await open('/treino/exercicios/mapa?face=back&muscle=lats');
    await eventually(fixture, () => expect(zone(el, 'lats')).not.toBeNull());
    expect(zone(el, 'lats')!.getAttribute('aria-pressed')).toBe('true');
    expect(el.querySelector('app-body-panel h3')?.textContent?.trim()).toBe('Dorsais');
  });

  it('follows the address when it changes from outside (the back button)', async () => {
    const { fixture, el, router } = await open();
    await eventually(fixture, () => expect(zone(el, 'chest')).not.toBeNull());
    await router.navigateByUrl('/treino/exercicios/mapa?face=back&muscle=glutes');
    await eventually(fixture, () =>
      expect(zone(el, 'glutes')!.getAttribute('aria-pressed')).toBe('true'),
    );
    expect(faceButton(el, 'Costas').getAttribute('aria-pressed')).toBe('true');
  });

  describe('the list of muscles', () => {
    it('has a button for every muscle of the taxonomy, grouped, with the exercise count', async () => {
      const { fixture, el } = await open();
      await eventually(fixture, () => expect(chip(el, 'chest')).not.toBeNull());
      const ids = Array.from(el.querySelectorAll('app-muscle-list .chip')).map(
        (button) => (button as HTMLElement).dataset['muscle'],
      );
      expect([...ids].sort()).toEqual([...MUSCLE_IDS].sort());
      const groups = Array.from(el.querySelectorAll('app-muscle-list .group-name')).map((n) =>
        n.textContent?.trim(),
      );
      expect(groups).toEqual(['Peito', 'Costas', 'Pernas', 'Ombros', 'Braços', 'Abdômen']);
      expect(chipName(el, 'chest')).toBe('Peitoral 2 exercícios');
      expect(chip(el, 'chest').querySelector('.count')?.firstChild?.textContent).toBe('2');
      expect(chipName(el, 'neck')).toBe('Pescoço 0 exercícios');
    });

    it('says "1 exercício" in the singular', async () => {
      const { fixture, el } = await open();
      await eventually(fixture, () => expect(chip(el, 'abdominals')).not.toBeNull());
      expect(chipName(el, 'abdominals')).toBe('Abdômen 1 exercício');
    });

    it('opens the panel of the muscle, with the same panel the figure opens', async () => {
      const { fixture, el } = await open();
      await eventually(fixture, () => expect(chip(el, 'quadriceps')).not.toBeNull());
      chip(el, 'quadriceps').click();
      await eventually(fixture, () => expect(panel(el)).not.toBeNull());
      expect(el.querySelector('app-body-panel h3')?.textContent?.trim()).toBe('Quadríceps');
      expect(chip(el, 'quadriceps').getAttribute('aria-pressed')).toBe('true');
      expect(zone(el, 'quadriceps')!.getAttribute('aria-pressed')).toBe('true');
    });

    it('turns the figure to the face where the muscle is, when it is not on the current one', async () => {
      const { fixture, el } = await open();
      await eventually(fixture, () => expect(chip(el, 'lats')).not.toBeNull());
      chip(el, 'lats').click();
      await eventually(fixture, () => expect(zone(el, 'lats')).not.toBeNull());
      expect(faceButton(el, 'Costas').getAttribute('aria-pressed')).toBe('true');
      expect(zone(el, 'lats')!.getAttribute('aria-pressed')).toBe('true');
      expect(path()).toContain('face=back');
    });
  });

  describe('the week volume', () => {
    async function openWithWeek() {
      const kit = await setupScreen([
        { path: 'treino/exercicios/mapa', component: BodyMapPage },
        { path: 'treino/exercicios', component: LibraryStub },
      ]);
      kit.runtime.time = at('2026-10-14', 12);
      await seedExerciseCatalog(kit.trainingDb);
      await kit.trainingDb.sessions.bulkPut([
        session('s1', '2026-10-13'),
        session('s0', '2026-10-06'),
      ]);
      await kit.trainingDb.sets.bulkPut([
        ...sets('a', 's1', 'remada', 12, '2026-10-13'),
        ...sets('b', 's1', 'rosca', 1, '2026-10-13'),
        ...sets('c', 's1', 'agacha', 5, '2026-10-13'),
        // Semana passada, aquecimento e série apagada não contam.
        ...sets('d', 's0', 'remada', 9, '2026-10-06'),
        ...sets('e', 's1', 'agacha', 3, '2026-10-13', { setType: 'warmup' }),
        localSet('f', 's1', {
          exerciseId: 'agacha',
          deletedAt: 5,
          completedAt: at('2026-10-13', 10),
        }),
      ]);
      return mount(kit, '/treino/exercicios/mapa?face=back');
    }

    it('colors the zones by the sets of the week, and says the number in the label', async () => {
      const { fixture, el } = await openWithWeek();
      await eventually(fixture, () => expect(zone(el, 'lats')!.dataset['level']).toBe('3'));
      expect(zone(el, 'lats')!.getAttribute('aria-label')).toBe(
        'Dorsais, 1 exercício, 12 séries nesta semana',
      );
      expect(zone(el, 'hamstrings')!.dataset['level']).toBe('0');
      expect(zone(el, 'hamstrings')!.getAttribute('aria-label')).toContain(
        'Nenhuma série nesta semana',
      );
    });

    it('shows the sets of the week in the panel, and the front has its own levels', async () => {
      const { fixture, el } = await openWithWeek();
      await eventually(fixture, () => expect(zone(el, 'lats')!.dataset['level']).toBe('3'));
      faceButton(el, 'Frente').click();
      await eventually(fixture, () => expect(zone(el, 'quadriceps')).not.toBeNull());
      expect(zone(el, 'quadriceps')!.dataset['level']).toBe('2');
      expect(zone(el, 'biceps')!.dataset['level']).toBe('1');
      zone(el, 'quadriceps')!.dispatchEvent(new Event('click'));
      await eventually(fixture, () => expect(panel(el)).not.toBeNull());
      const chipText = el.querySelector('app-body-panel .ui-chip')!;
      expect(chipText.textContent?.trim()).toBe('5 séries nesta semana');
      expect(chipText.classList.contains('accent')).toBe(true);
    });

    it('does not tint a muscle with no sets, and the panel says it plainly', async () => {
      const { fixture, el } = await openWithWeek();
      await eventually(fixture, () => expect(zone(el, 'lats')!.dataset['level']).toBe('3'));
      zone(el, 'hamstrings')!.dispatchEvent(new Event('click'));
      await eventually(fixture, () => expect(panel(el)).not.toBeNull());
      const chipText = el.querySelector('app-body-panel .ui-chip')!;
      expect(chipText.textContent?.trim()).toBe('Nenhuma série nesta semana');
      expect(chipText.classList.contains('accent')).toBe(false);
      // Sem exercício no catálogo: o painel diz isso e não oferece uma lista vazia.
      expect(el.querySelector('app-body-panel .none')).not.toBeNull();
      expect(el.querySelector('app-body-panel .foot')).toBeNull();
    });

    it('describes the colors in numbers in the legend', async () => {
      const { fixture, el } = await openWithWeek();
      await eventually(fixture, () => expect(zone(el, 'lats')).not.toBeNull());
      const steps = Array.from(el.querySelectorAll('.legend .step')).map((n) =>
        n.textContent?.trim(),
      );
      expect(steps).toEqual(['0', '1–3', '4–9', '10+']);
      expect(el.querySelector('.legend-title')?.textContent?.trim()).toBe('Séries na semana');
    });
  });

  describe('without the catalog', () => {
    it('explains that the catalog has not arrived, instead of drawing a body with no exercises', async () => {
      const { fixture, el } = await open('/treino/exercicios/mapa', []);
      await eventually(fixture, () => expect(el.querySelector('.empty')).not.toBeNull());
      expect(el.querySelector('.empty h3')?.textContent).toMatch(/catálogo/i);
      expect(el.querySelector('.figure')).toBeNull();
      expect(el.querySelector('app-muscle-list')).toBeNull();
    });
  });

  it('goes back to the exercises when there is no history to go back to', async () => {
    const { fixture, el, router } = await open();
    await eventually(fixture, () => expect(zone(el, 'chest')).not.toBeNull());
    const navigate = vi.spyOn(router, 'navigateByUrl');
    el.querySelector<HTMLButtonElement>('.back')!.click();
    expect(navigate).toHaveBeenCalledWith('/treino/exercicios');
  });

  it('announces the muscle that was chosen, in text, for a screen reader', async () => {
    const { fixture, el } = await open();
    await eventually(fixture, () => expect(zone(el, 'chest')).not.toBeNull());
    expect(el.querySelector('[role="status"]')?.textContent?.trim()).toBe('');
    zone(el, 'chest')!.dispatchEvent(new Event('click'));
    await eventually(fixture, () =>
      expect(el.querySelector('[role="status"]')?.textContent?.trim()).toBe(
        'Peitoral: 2 exercícios, Nenhuma série nesta semana',
      ),
    );
  });
});
