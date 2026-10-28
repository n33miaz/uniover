import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { OfflineQueue } from '../../../../core/offline-queue/offline-queue';
import { CatalogRepository } from '../../data/catalog/catalog-repository';
import { CatalogWriter } from '../../data/catalog/catalog-writer';
import type { LocalExercise } from '../../data/catalog/exercise';
import { RoutineRepository } from '../../data/routines/routine-repository';
import { localExercise } from '../../data/sync/training-test-kit';
import {
  catalog,
  eventually,
  item,
  saveRoutine,
  seedHistory,
  setupScreen,
} from '../../shell/screen-test-kit';
import { ExerciseDetailPage, historyRows } from './detail.page';

describe('ExerciseDetailPage', () => {
  async function open(id: string, extra: LocalExercise[] = []) {
    const kit = await setupScreen([
      { path: 'treino/exercicios/:id', component: ExerciseDetailPage },
      { path: '**', children: [] },
    ]);
    await kit.trainingDb.exercises.bulkPut([...catalog(), ...extra]);
    const harness = await kit.harness();
    await harness.navigateByUrl(`/treino/exercicios/${id}`, ExerciseDetailPage);
    const el = harness.routeNativeElement as HTMLElement;
    return { ...kit, fixture: harness.fixture, el, router: TestBed.inject(Router) };
  }

  const text = (el: HTMLElement) => el.textContent?.replace(/\s+/g, ' ') ?? '';
  const chips = (el: HTMLElement) =>
    Array.from(el.querySelectorAll('.chips li')).map((chip) => chip.textContent?.trim());
  const button = (el: HTMLElement, label: string | RegExp) =>
    Array.from(el.querySelectorAll<HTMLButtonElement | HTMLAnchorElement>('button, a')).find(
      (node) =>
        typeof label === 'string'
          ? node.textContent?.trim() === label
          : label.test(node.textContent ?? ''),
    )!;

  describe('an exercise with an illustration', () => {
    it('centers the illustration, badges and muscle diagram', async () => {
      const { fixture, el } = await open('supino-reto');
      await eventually(fixture, () =>
        expect(el.querySelector('h2')?.textContent).toContain('Supino reto'),
      );
      expect(chips(el)).toEqual([
        'Peitoral',
        'Tríceps · secundário',
        'Ombros · secundário',
        'Barra',
      ]);
      expect(el.querySelectorAll('app-exercise-illustration img')).toHaveLength(2);
      // Só o voltar vem antes da imagem; o nome segue logo depois dela.
      expect(el.querySelector('.detail')?.firstElementChild?.classList.contains('head')).toBe(true);
      expect(el.querySelector('.head')?.nextElementSibling?.classList.contains('hero')).toBe(true);
      const hero = el.querySelector('.hero')!;
      expect(hero.querySelector('.visuals')?.nextElementSibling?.classList.contains('chips')).toBe(
        true,
      );
      expect(hero.querySelectorAll('.visuals > *')).toHaveLength(2);
      expect(hero.querySelector('.visuals app-exercise-muscles')).not.toBeNull();
      // Com ilustração, o cartão dos músculos acompanha o tamanho do cartão dela.
      expect(hero.querySelector('.visuals app-exercise-muscles')?.classList.contains('fill')).toBe(
        true,
      );
      expect(hero.querySelector('h3')).toBeNull();
      expect(hero.querySelector('.muscle-legend')).toBeNull();
      expect(el.querySelectorAll('.muscle-figure')).toHaveLength(2);
      expect(el.querySelectorAll('.zone.primary')).toHaveLength(1);
      expect(el.querySelectorAll('.zone.secondary').length).toBeGreaterThan(0);
      expect(el.querySelector('.origin')).toBeNull();
      expect(el.querySelector('app-exercise-credit-line')).toBeNull();
    });

    it('leaves out the chip of the usual record type (load and repetitions)', async () => {
      const { fixture, el } = await open('supino-reto');
      await eventually(fixture, () => expect(chips(el).length).toBeGreaterThan(0));
      expect(chips(el)).not.toContain('Carga e repetições');
    });

    it('shows the first three steps and the rest after "Ver todos"', async () => {
      const { fixture, el } = await open('supino-reto');
      await eventually(fixture, () => expect(el.querySelectorAll('.steps li')).toHaveLength(3));
      const more = button(el, /Ver Todos os 5 Passos/);
      expect(more.getAttribute('aria-expanded')).toBe('false');
      more.click();
      fixture.detectChanges();
      expect(el.querySelectorAll('.steps li')).toHaveLength(5);
      expect(button(el, 'Ver Menos').getAttribute('aria-expanded')).toBe('true');
    });
  });

  describe('an exercise without an illustration', () => {
    it('still shows a centered muscle diagram when no exercise illustration exists', async () => {
      const { fixture, el } = await open('prancha');
      await eventually(fixture, () =>
        expect(el.querySelector('h2')?.textContent).toContain('Prancha'),
      );
      expect(el.querySelector('app-exercise-illustration')).toBeNull();
      expect(el.querySelector('app-exercise-credit-line')).toBeNull();
      expect(el.querySelectorAll('.muscle-figure')).toHaveLength(1);
      expect(el.querySelector('.muscle-figure figcaption')?.textContent).toBe('Frente');
      expect(chips(el)).toEqual(['Abdômen', 'Peso do corpo', 'Tempo']);
      expect(el.querySelectorAll('.visuals > *')).toHaveLength(1);
      expect(el.querySelector('app-exercise-muscles')?.classList.contains('fill')).toBe(false);
      expect(el.querySelector('.visuals')?.nextElementSibling?.classList.contains('chips')).toBe(
        true,
      );
      expect(el.querySelector('.hero h3')).toBeNull();
    });

    it('says there is no step by step', async () => {
      const { fixture, el } = await open('prancha');
      await eventually(fixture, () => expect(text(el)).toContain('ainda não tem passo a passo'));
    });
  });

  describe('an exercise from wger', () => {
    const wger = localExercise('wger-1', {
      source: 'wger',
      slug: 'remada-wger',
      name: 'Remada unilateral',
      license: 'CC-BY-SA 4',
      licenseAuthor: 'Maria Souza',
      licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0/',
    });

    it('shows the author and links the license in the exercise footer', async () => {
      const { fixture, el } = await open('wger-1', [wger]);
      await eventually(fixture, () => expect(el.querySelector('.muscle-figure')).not.toBeNull());
      const credit = el.querySelector('.source-credit');
      expect(credit?.textContent?.replace(/\s+/g, ' ')).toContain(
        'Exercício: Maria Souza, CC-BY-SA 4',
      );
      const license = credit?.querySelector<HTMLAnchorElement>('a');
      expect(license?.getAttribute('href')).toBe('https://creativecommons.org/licenses/by-sa/4.0/');
      expect(license?.getAttribute('target')).toBe('_blank');
      expect(license?.getAttribute('rel')).toBe('noopener noreferrer');
    });

    it('shows an unsafe license address as text instead of a link', async () => {
      const { fixture, el } = await open('wger-unsafe', [
        { ...wger, id: 'wger-unsafe', licenseUrl: 'javascript:alert(1)' },
      ]);
      await eventually(fixture, () => expect(el.querySelector('.source-credit')).not.toBeNull());
      const credit = el.querySelector('.source-credit');
      expect(credit?.textContent?.replace(/\s+/g, ' ')).toContain(
        'Exercício: Maria Souza, CC-BY-SA 4',
      );
      expect(credit?.querySelector('a')).toBeNull();
    });
  });

  describe('an exercise of your own', () => {
    const own = localExercise('meu', {
      source: 'own',
      slug: 'meu-exercicio',
      name: 'Remada na máquina',
      primaryMuscles: ['middle_back'],
      instructions: [],
    });

    it('is marked as yours and offers Editar and Apagar', async () => {
      const { fixture, el } = await open('meu', [own]);
      await eventually(fixture, () =>
        expect(el.querySelector('h2')?.textContent).toContain('Remada'),
      );
      expect(chips(el)).toContain('própria');
      expect(text(el)).toContain('Exercício criado por você neste aparelho');
      expect(el.querySelector('a[href$="/editar"]')?.getAttribute('href')).toBe(
        '/treino/exercicios/meu/editar',
      );
      expect(text(el)).toContain('só o que você digitar ao editar');
    });

    it('does not offer Editar or Apagar for a catalog exercise', async () => {
      const { fixture, el } = await open('supino-reto');
      await eventually(fixture, () => expect(chips(el).length).toBeGreaterThan(0));
      expect(el.querySelector('a[href$="/editar"]')).toBeNull();
      expect(button(el, /^\s*Apagar\s*$/)).toBeUndefined();
    });

    it('asks before deleting, and "Manter" gives up', async () => {
      const { fixture, el, trainingDb } = await open('meu', [own]);
      await eventually(fixture, () => expect(button(el, /^\s*Apagar\s*$/)).toBeDefined());
      button(el, /^\s*Apagar\s*$/).click();
      fixture.detectChanges();
      expect(text(el)).toContain('Apagar este exercício?');
      button(el, 'Manter').click();
      fixture.detectChanges();
      expect(el.querySelector('.confirm')).toBeNull();
      expect((await trainingDb.exercises.get('meu'))?.deletedAt).toBeNull();
    });

    it('deletes by a tombstone and queues the write once, after the confirmation', async () => {
      const { fixture, el, trainingDb } = await open('meu', [own]);
      await eventually(fixture, () => expect(button(el, /^\s*Apagar\s*$/)).toBeDefined());
      button(el, /^\s*Apagar\s*$/).click();
      fixture.detectChanges();
      el.querySelector<HTMLButtonElement>('.confirm button.danger')!.click();
      await vi.waitFor(async () =>
        expect((await trainingDb.exercises.get('meu'))?.deletedAt).not.toBeNull(),
      );
      const queue = await TestBed.inject(OfflineQueue).items();
      expect(queue).toHaveLength(1);
      expect(queue[0]).toMatchObject({ method: 'PUT', body: { deleted: true } });
    });
  });

  describe('the history', () => {
    it('shows the record, the estimated 1RM and the last days with the best set, marking the record', async () => {
      const { fixture, el, trainingDb } = await open('supino-reto');
      await seedHistory(trainingDb, 'supino-reto', [
        [0, 40, 10],
        [3, 42.5, 8],
        [6, 40, 12],
        [9, 45, 6],
      ]);
      TestBed.inject(CatalogRepository).writeLocal(
        (await trainingDb.exercises.get('supino-reto'))!,
      );
      const facts = () =>
        Array.from(el.querySelectorAll('.fact')).map((row) => [
          row.querySelector('dt')?.textContent?.replace(/\s+/g, ' ').trim(),
          row.querySelector('dd')?.textContent?.trim(),
        ]);
      await eventually(fixture, () => expect(facts()[0]).toEqual(['Carga máxima', '45 kg']));
      expect(facts()[1]).toEqual(['1RM estimado', '54 kg']);
      // Os três últimos dias, do mais novo ao mais velho; só os dias que bateram a carga máxima levam "Recorde".
      const days = facts().slice(2);
      expect(days.map(([, value]) => value)).toEqual(['45 kg × 6', '40 kg × 12', '42,5 kg × 8']);
      expect(days.map(([day]) => /Recorde/.test(day ?? ''))).toEqual([true, false, true]);
      expect(days.every(([day]) => /^\d{2}\/\d{2}/.test(day ?? ''))).toBe(true);
      const link = el.querySelector<HTMLAnchorElement>('a[href^="/treino/progresso"]')!;
      expect(link.getAttribute('href')).toBe('/treino/progresso?exercise=supino-reto');
    });

    it('says there is no record yet', async () => {
      const { fixture, el } = await open('supino-reto');
      await eventually(fixture, () =>
        expect(text(el)).toContain('Sem registro deste exercício ainda'),
      );
      expect(el.querySelector('a[href^="/treino/progresso"]')).toBeNull();
    });

    it('historyRows keeps three days, newest first', () => {
      const point = (n: number, kg: number) => ({
        date: `2026-10-0${n}`,
        at: Date.UTC(2026, 9, n, 12),
        topWeightKg: kg,
        topWeightReps: 8,
        oneRepMaxKg: null,
        volumeKg: 0,
        workingSets: 1,
      });
      const rows = historyRows([point(1, 40), point(2, 40), point(3, 42), point(4, 41)]);
      expect(rows.map((row) => [row.kg, row.record])).toEqual([
        [41, false],
        [42, true],
        [40, false],
      ]);
    });
  });

  describe('adding to a routine', () => {
    it('lists the routines and adds the exercise with 3 sets of 8 to 12 repetitions', async () => {
      const { fixture, el } = await open('prancha');
      const routine = await saveRoutine('Treino A', [item('i1', 'agachamento', 0)]);
      await eventually(fixture, () => expect(button(el, /Adicionar a um Treino/)).toBeDefined());
      button(el, /Adicionar a um Treino/).click();
      await eventually(fixture, () => expect(el.querySelector('dialog')).not.toBeNull());
      expect(el.querySelector('dialog')?.getAttribute('aria-labelledby')).toBeTruthy();
      const row = Array.from(el.querySelectorAll<HTMLButtonElement>('dialog .ui-row')).find(
        (node) => node.textContent?.includes('Treino A'),
      )!;
      expect(row.textContent).toContain('1 exercício');
      row.click();
      await eventually(fixture, () => expect(el.querySelector('.added')).not.toBeNull());
      expect(el.querySelector('.added')?.textContent).toContain('Adicionado a Treino A.');
      expect(el.querySelector('.added a')?.getAttribute('href')).toBe(
        `/treino/rotinas/${routine.id}`,
      );
      expect(el.querySelector('dialog')).toBeNull();
      const saved = (await TestBed.inject(RoutineRepository).get(routine.id))!;
      expect(saved.items).toHaveLength(2);
      expect(saved.items[1]).toMatchObject({
        exerciseId: 'prancha',
        targetSets: 3,
        repMin: 8,
        repMax: 12,
      });
    });

    it('offers to create a routine with the exercise when there is none', async () => {
      const { fixture, el } = await open('prancha');
      await eventually(fixture, () => expect(button(el, /Adicionar a um Treino/)).toBeDefined());
      button(el, /Adicionar a um Treino/).click();
      await eventually(fixture, () => expect(el.querySelector('dialog')).not.toBeNull());
      expect(text(el)).toContain('Você ainda não tem rotinas');
      const create = el.querySelector<HTMLAnchorElement>('dialog a')!;
      expect(create.getAttribute('href')).toBe('/treino/rotinas/nova?exercicio=prancha');
    });

    it('says so when the routine is already full', async () => {
      const { fixture, el } = await open('prancha');
      const full = Array.from({ length: 40 }, (_, n) => item(`i${n}`, 'agachamento', n));
      await saveRoutine('Cheia', full);
      await eventually(fixture, () => expect(button(el, /Adicionar a um Treino/)).toBeDefined());
      button(el, /Adicionar a um Treino/).click();
      await eventually(fixture, () => expect(el.querySelector('dialog .ui-row')).not.toBeNull());
      el.querySelector<HTMLButtonElement>('dialog .ui-row')!.click();
      await eventually(fixture, () => expect(text(el)).toContain('máximo de exercícios'));
      expect(el.querySelector('dialog')).not.toBeNull();
    });
  });

  describe('the load step', () => {
    it('shows the equipment default and saves a new step by the writer, queued once', async () => {
      const { fixture, el, trainingDb } = await open('supino-reto');
      await eventually(fixture, () => expect(text(el)).toContain('padrão de barra'));
      expect(text(el)).toContain('2,5 kg');
      button(el, 'Editar').click();
      fixture.detectChanges();
      const input = el.querySelector<HTMLInputElement>('#step-input')!;
      expect(input.value).toBe('2,5');
      input.value = '5';
      input.dispatchEvent(new Event('input'));
      button(el, 'Salvar').click();
      await vi.waitFor(async () =>
        expect((await trainingDb.exercises.get('supino-reto'))?.stepKg).toBe(5),
      );
      await eventually(fixture, () => expect(text(el)).toContain('ajustado por você'));
      const queue = await TestBed.inject(OfflineQueue).items();
      expect(queue).toHaveLength(1);
      expect(queue[0].url).toContain('/exercises/supino-reto/step');
    });

    it('refuses a step that is not a number', async () => {
      const { fixture, el, trainingDb } = await open('supino-reto');
      await eventually(fixture, () => expect(text(el)).toContain('padrão de barra'));
      button(el, 'Editar').click();
      fixture.detectChanges();
      const input = el.querySelector<HTMLInputElement>('#step-input')!;
      input.value = 'abc';
      input.dispatchEvent(new Event('input'));
      button(el, 'Salvar').click();
      await eventually(fixture, () =>
        expect(el.querySelector('.error')?.textContent).toContain('0 a 100'),
      );
      expect((await trainingDb.exercises.get('supino-reto'))?.stepKg).toBeNull();
    });

    it('goes back to the equipment default', async () => {
      const { fixture, el, trainingDb } = await open('supino-reto');
      await TestBed.inject(CatalogWriter).setStepKg('supino-reto', 4);
      await eventually(fixture, () => expect(text(el)).toContain('ajustado por você'));
      button(el, 'Editar').click();
      fixture.detectChanges();
      button(el, 'Voltar ao Padrão do Equipamento').click();
      await vi.waitFor(async () =>
        expect((await trainingDb.exercises.get('supino-reto'))?.stepKg).toBeNull(),
      );
    });

    it('does not show a step value for an exercise with no suggested step', async () => {
      const { fixture, el } = await open('prancha');
      await eventually(fixture, () => expect(text(el)).toContain('sem salto sugerido'));
      expect(el.querySelector('.step-value')).toBeNull();
    });
  });

  it('has a single way back, first in the reading order, that leads to the exercise list', async () => {
    const { fixture, el, router } = await open('supino-reto');
    await eventually(fixture, () =>
      expect(el.querySelector('h2')?.textContent).toContain('Supino'),
    );
    expect(el.querySelectorAll('.back')).toHaveLength(1);
    const back = el.querySelector<HTMLButtonElement>('.back')!;
    expect(back.getAttribute('aria-label')).toBe('Voltar para Exercícios');
    // O voltar vem antes da imagem (que é a primeira coisa da ficha, por decisão) e do nome.
    const order = (a: Element, b: Element) =>
      a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING;
    expect(order(back, el.querySelector('app-exercise-illustration')!)).toBeTruthy();
    expect(order(back, el.querySelector('h2')!)).toBeTruthy();

    const navigate = vi.spyOn(router, 'navigateByUrl');
    back.click();
    expect(navigate).toHaveBeenCalledWith('/treino/exercicios');
  });

  it('says the exercise was not found, with a way back', async () => {
    const { fixture, el, router } = await open('nada');
    await eventually(fixture, () => expect(text(el)).toContain('Exercício não encontrado'));
    const navigate = vi.spyOn(router, 'navigateByUrl');
    (el.querySelector('.back') as HTMLButtonElement).click();
    expect(navigate).toHaveBeenCalledWith('/treino/exercicios');
  });
});
