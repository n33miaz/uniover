import { TestBed } from '@angular/core/testing';
import { ConnectivityService } from '../../../core/connectivity/connectivity.service';
import { RestTimerService } from '../data/session-live/rest-timer.service';
import { SessionRepository } from '../data/sessions/session-repository';
import { setupSessions } from '../data/sessions/session-data-test-kit';
import {
  HISTORY_START,
  catalog,
  eventually,
  item,
  saveRoutine,
  seedHistory,
} from '../shell/screen-test-kit';
import { TrainingSync } from '../data/sync/training-sync';
import { Location } from '@angular/common';
import { provideRouter, Router } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { TrainingHeaderActions } from '../shell/training-header-actions';
import { DOUBLE_TAP_MS } from './live-store';
import { TodayPage } from './today.page';
import { WorkoutDay } from './workout-day';
import { WorkoutExercise } from './workout-exercise';

const HOUR = 3_600_000;

async function open(url = '/treino') {
  TestBed.configureTestingModule({
    providers: [
      provideRouter([
        { path: 'treino', component: TodayPage },
        { path: 'treino/sessao', component: WorkoutDay },
        { path: 'treino/sessao/exercicio', component: WorkoutExercise },
      ]),
    ],
  });
  const t = setupSessions();
  await TestBed.inject(TrainingSync).start();
  await t.trainingDb.exercises.bulkPut(catalog());
  localStorage.clear();
  const harness = await RouterTestingHarness.create();
  return { ...t, harness, url };
}

type Kit = Awaited<ReturnType<typeof open>>;

async function show(kit: Kit) {
  await kit.harness.navigateByUrl(kit.url, TodayPage);
  const el = kit.harness.routeNativeElement as HTMLElement;
  return { el, fixture: kit.harness.fixture };
}

/** O menu mora no topo compartilhado da casca: a tela só registra a ação, e aqui se faz o que o botão do topo faz. */
const openHeaderMenu = (id: string) => {
  const action = TestBed.inject(TrainingHeaderActions)
    .actions()
    .find((item) => item.id === id);
  expect(action?.label).toBe('Opções do treino');
  action!.run();
};
const text = (el: Element) => el.textContent?.replace(/\s+/g, ' ') ?? '';
const buttons = (el: ParentNode) => Array.from(el.querySelectorAll<HTMLButtonElement>('button'));
const button = (el: ParentNode, label: string) =>
  buttons(el).find((node) => node.textContent?.replace(/\s+/g, ' ').includes(label))!;

describe('TodayPage', () => {
  afterEach(() => localStorage.clear());

  describe('the day', () => {
    it('says there are no routines yet, and still lets the person train without one', async () => {
      const kit = await open();
      const { el, fixture } = await show(kit);

      await eventually(fixture, () => expect(text(el)).toContain('Sem Rotinas Ainda'));
      expect(el.querySelector<HTMLAnchorElement>('a[href="/treino/rotinas"]')).not.toBeNull();
      expect(button(el, 'Treino Livre')).toBeDefined();
    });

    it('shows the exercise illustration in each line of the open routine, like the other lists, with the neutral frame as fallback', async () => {
      const kit = await open();
      await saveRoutine('Treino A', [
        item('a1', 'supino-reto', 0),
        item('a2', 'prancha', 1),
        item('a3', 'removido-do-catalogo', 2),
      ]);
      const { el, fixture } = await show(kit);

      await eventually(fixture, () =>
        expect(el.querySelectorAll('.lines .ui-row')).toHaveLength(3),
      );
      button(el, 'Ver Rotina').click();
      await eventually(fixture, () =>
        expect(el.querySelector<HTMLElement>('.lines')?.hidden).toBe(false),
      );
      const rows = Array.from(el.querySelectorAll<HTMLElement>('.lines .ui-row'));
      // A mesma miniatura de 64 px da biblioteca de exercícios, no começo da linha.
      expect(rows[0].firstElementChild?.matches('app-exercise-thumb.thumb')).toBe(true);
      expect(rows[0].querySelector('.thumb img')?.getAttribute('src')).toContain(
        '/exercise-art/0042-relaxation.svg',
      );
      expect(getComputedStyle(rows[0].querySelector('.thumb')!).width).toBe('64px');
      // Sem arte segura, ou com o exercício já fora do catálogo, o glifo neutro mantém a moldura.
      for (const row of rows.slice(1)) {
        expect(row.querySelector('.thumb img')).toBeNull();
        expect(row.querySelector('.thumb .placeholder app-training-glyph')).not.toBeNull();
      }
    });

    it('offers the program choice when starting without a weekly program, and does not start until it is answered', async () => {
      const kit = await open();
      await saveRoutine('Treino A', [item('a1', 'supino-reto', 0)]);
      const { el, fixture } = await show(kit);

      await eventually(fixture, () => expect(button(el, 'Iniciar Treino')).toBeDefined());
      button(el, 'Iniciar Treino').click();

      await eventually(fixture, () =>
        expect(el.querySelector('app-training-sheet')).not.toBeNull(),
      );
      expect(text(el)).toContain('Programa Semanal');
      expect(el.querySelector('app-live-session')).toBeNull();
    });

    it('puts the routine of the day first and the week below it, with one main button above the list', async () => {
      const kit = await open();
      await seedHistory(kit.trainingDb, 'supino-reto', [[1, 40, 10]]);
      await saveRoutine('Treino A', [
        item('a1', 'supino-reto', 0, { targetSets: 4, repMin: 6, repMax: 10 }),
        item('a2', 'agachamento', 1, { supersetGroup: 1 }),
        item('a3', 'elevacao', 2, { supersetGroup: 1 }),
      ]);
      const { el, fixture } = await show(kit);

      await eventually(fixture, () =>
        expect(el.querySelectorAll('.lines .ui-row')).toHaveLength(3),
      );
      const week = el.querySelector('.week')!;
      const routine = el.querySelector('.routine')!;
      // A rotina do dia vem primeiro e a semana confirma o contexto depois; nada de busca nem de "Trocar rotina".
      expect(routine.compareDocumentPosition(week) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(el.querySelector('input[type="search"]')).toBeNull();
      expect(routine.querySelector('button.routine-settings')?.getAttribute('aria-label')).toBe(
        'Configurar Rotina',
      );
      // O botão é discreto: três pontos (três subtrechos num só desenho cheio), não a engrenagem.
      const dots = routine.querySelector('button.routine-settings svg path.solid');
      expect(dots?.getAttribute('d')?.match(/z/g)).toHaveLength(3);
      expect(text(routine)).toContain('Treino A');
      expect(text(routine)).toMatch(/3 exercícios · 10 séries · cerca de \d+ min/);
      const start = button(el, 'Iniciar Treino');
      expect(start.compareDocumentPosition(el.querySelector('.lines')!)).toBe(
        Node.DOCUMENT_POSITION_FOLLOWING,
      );
      // A lista vem recolhida atrás de "Ver Rotina" e abre num toque.
      const toggle = button(el, 'Ver Rotina');
      expect(toggle.getAttribute('aria-expanded')).toBe('false');
      expect(el.querySelector<HTMLElement>('.lines')?.hidden).toBe(true);
      toggle.click();
      await eventually(fixture, () => {
        expect(el.querySelector<HTMLElement>('.lines')?.hidden).toBe(false);
        expect(toggle.getAttribute('aria-expanded')).toBe('true');
      });
      const rows = Array.from(el.querySelectorAll('.lines .ui-row')).map((row) => text(row));
      expect(rows[0]).toContain('4 × 6–10 · última vez 40 kg × 10');
      expect(rows[1]).toContain('supersérie');
      // O "?" do glossário fica ao lado da ação, sem ocupar uma linha própria.
      const glossary = el.querySelector<HTMLAnchorElement>('.actions a.glossary-link');
      expect(glossary?.getAttribute('href')).toBe('/treino/glossario');
      expect(glossary?.getAttribute('aria-label')).toBe(
        'Entender Programa Semanal, Rotina e Exercício',
      );
    });

    it('offers yesterday workout as a shortcut and opens its summary', async () => {
      const kit = await open();
      await saveRoutine('Treino A', [item('a1', 'supino-reto', 0)]);
      const dayMs = 86_400_000;
      // Começou exatamente 24 h antes do relógio do teste: cai sempre no dia anterior.
      const day = (kit.runtime.now() - dayMs - HISTORY_START) / dayMs;
      await seedHistory(kit.trainingDb, 'supino-reto', [[day, 40, 10]]);
      const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
      const { el, fixture } = await show(kit);

      await eventually(fixture, () => expect(text(el)).toContain('Treino de Ontem'));
      const link = Array.from(el.querySelectorAll<HTMLButtonElement>('.links button')).find(
        (node) => text(node).includes('Treino de Ontem'),
      )!;
      expect(text(link)).toContain('Ver Resumo');
      link.click();

      expect(navigate).toHaveBeenCalledWith(['/treino'], {
        queryParams: { resumo: `supino-reto-treino-${day}`, historico: '1' },
      });
    });

    it('names an older workout "Último Treino" with its date', async () => {
      const kit = await open();
      await saveRoutine('Treino A', [item('a1', 'supino-reto', 0)]);
      await seedHistory(kit.trainingDb, 'supino-reto', [[1, 40, 10]]);
      const { el, fixture } = await show(kit);

      await eventually(fixture, () => expect(text(el)).toContain('Último Treino'));
      expect(text(el)).not.toContain('Treino de Ontem');
      expect(text(el.querySelector('.links')!)).toContain('junho');
    });

    it('finds the last valid workout even behind many empty sessions', async () => {
      const kit = await open();
      await saveRoutine('Treino A', [item('a1', 'supino-reto', 0)]);
      await seedHistory(kit.trainingDb, 'supino-reto', [[1, 40, 10]]);
      // Sete sessões encerradas sem nenhuma série, todas mais novas que o treino válido.
      const empty = Array.from({ length: 7 }, (_, index) => {
        const startedAt = HISTORY_START + (index + 2) * 86_400_000;
        return {
          id: `vazio-${index}`,
          routineId: null,
          startedAt,
          finishedAt: startedAt + 60_000,
          note: '',
          feeling: null,
          deviceId: 'd',
          updatedAt: startedAt,
          clientUpdatedAt: startedAt,
          deletedAt: null,
        };
      });
      await kit.trainingDb.sessions.bulkPut(empty);
      const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
      const { el, fixture } = await show(kit);

      await eventually(fixture, () => expect(text(el)).toContain('Último Treino'));
      Array.from(el.querySelectorAll<HTMLButtonElement>('.links button'))
        .find((node) => text(node).includes('Último Treino'))!
        .click();
      expect(navigate).toHaveBeenCalledWith(['/treino'], {
        queryParams: { resumo: 'supino-reto-treino-1', historico: '1' },
      });
    });

    it('keeps the rest of the screen when the local database fails reading the sets', async () => {
      const kit = await open();
      await saveRoutine('Treino A', [item('a1', 'supino-reto', 0)]);
      await seedHistory(kit.trainingDb, 'supino-reto', [[1, 40, 10]]);
      vi.spyOn(TestBed.inject(SessionRepository), 'setsOfSession').mockRejectedValue(
        new Error('indexeddb indisponível'),
      );
      const { el, fixture } = await show(kit);

      // A rotina, o botão e a semana continuam; só o atalho do treino anterior some.
      await eventually(fixture, () => expect(button(el, 'Iniciar Treino')).toBeDefined());
      expect(el.querySelector('.week')).not.toBeNull();
      expect(text(el)).toContain('Treino A');
      expect(text(el)).not.toContain('Último Treino');
      expect(text(el)).not.toContain('Treino de Ontem');
    });

    it('still shows the day card and the shortcuts without the catalog, and only the start waits', async () => {
      const kit = await open();
      await saveRoutine('Treino A', [item('a1', 'supino-reto', 0)]);
      await seedHistory(kit.trainingDb, 'supino-reto', [[1, 40, 10]]);
      await kit.trainingDb.exercises.clear();
      TestBed.inject(ConnectivityService).online.set(false);
      const { el, fixture } = await show(kit);

      await eventually(fixture, () => expect(button(el, 'Iniciar Treino')).toBeDefined());
      expect(button(el, 'Iniciar Treino').disabled).toBe(true);
      expect(button(el, 'Treino Livre').disabled).toBe(true);
      expect(text(el)).toContain('O catálogo ainda não chegou');
      expect(el.querySelector('.week')).not.toBeNull();
      await eventually(fixture, () => expect(text(el)).toContain('Último Treino'));
    });

    it('opens the model comparison from the program shortcut, to switch the program in place', async () => {
      const kit = await open();
      await kit.trainingDb.program.put({
        id: 'active',
        programId: 'p',
        updatedAt: 1,
        clientUpdatedAt: 1,
      });
      await saveRoutine('Segunda · Peito', [item('a1', 'supino-reto', 0)]);
      const routine = (await kit.trainingDb.routines.toArray())[0];
      await kit.trainingDb.routines.put({ ...routine, programId: 'p', weekdays: [1] });
      const { el, fixture } = await show(kit);

      await eventually(fixture, () => expect(el.querySelector('.links button')).not.toBeNull());
      el.querySelector<HTMLButtonElement>('.links button')!.click();
      await eventually(fixture, () =>
        expect(el.querySelector('app-templates-sheet')).not.toBeNull(),
      );
    });

    it('hides the shortcuts when there is no program and no earlier workout', async () => {
      const kit = await open();
      await saveRoutine('Treino A', [item('a1', 'supino-reto', 0)]);
      const { el, fixture } = await show(kit);

      await eventually(fixture, () => expect(button(el, 'Iniciar Treino')).toBeDefined());
      expect(el.querySelector('.links')).toBeNull();
    });

    it('shows the active weekly program with its summary as a shortcut', async () => {
      const kit = await open();
      await kit.trainingDb.program.put({
        id: 'active',
        programId: 'p',
        updatedAt: 1,
        clientUpdatedAt: 1,
      });
      await saveRoutine('Segunda · Peito', [item('a1', 'supino-reto', 0)]);
      const routine = (await kit.trainingDb.routines.toArray())[0];
      await kit.trainingDb.routines.put({ ...routine, programId: 'p', weekdays: [1] });
      const { el, fixture } = await show(kit);

      await eventually(fixture, () => expect(el.querySelector('.links button')).not.toBeNull());
      const link = el.querySelector('.links button')!;
      expect(text(link)).toContain('Programa da Semana');
      expect(text(link)).toContain('Peito');
    });

    it('has a single heading for Início', async () => {
      const kit = await open();
      await saveRoutine('Treino A', [item('a1', 'supino-reto', 0)]);
      const { el, fixture } = await show(kit);

      await eventually(fixture, () => expect(el.querySelector('.routine')).not.toBeNull());
      const headings = Array.from(el.querySelectorAll('h1, h2, h3')).filter((node) =>
        node.textContent?.includes('Início'),
      );
      expect(headings).toHaveLength(1);
    });

    it('blocks the start when another device has a workout open, and offers to end it after 12 hours', async () => {
      const kit = await open();
      await saveRoutine('Treino A', [item('a1', 'supino-reto', 0)]);
      const startedAt = kit.runtime.now() - 13 * HOUR;
      await kit.trainingDb.sessions.put({
        id: 'outro',
        routineId: null,
        startedAt,
        finishedAt: null,
        note: '',
        feeling: null,
        deviceId: 'outro-aparelho',
        updatedAt: startedAt,
        clientUpdatedAt: startedAt,
        deletedAt: null,
      });
      const { el, fixture } = await show(kit);

      await eventually(fixture, () =>
        expect(text(el)).toContain('Treino Aberto em Outro Aparelho'),
      );
      expect(text(el)).toContain('há 13 h');
      expect(buttons(el).some((node) => node.textContent?.includes('Iniciar Treino'))).toBe(false);

      button(el, 'Encerrar o Treino Esquecido').click();
      await eventually(fixture, () => expect(text(el)).toContain('As séries dele ficam salvas'));
      button(el, 'Sim, Encerrar').click();
      await eventually(fixture, () => expect(text(el)).toContain('Treino esquecido encerrado'));
      await eventually(fixture, () => expect(button(el, 'Iniciar Treino')).toBeDefined());
    });

    it('asks for a connection when the catalog has not arrived yet', async () => {
      const kit = await open();
      await kit.trainingDb.exercises.clear();
      TestBed.inject(ConnectivityService).online.set(false);
      const { el, fixture } = await show(kit);

      await eventually(fixture, () => expect(text(el)).toContain('O Catálogo Ainda Não Chegou'));
    });
  });

  describe('a workout already open here', () => {
    it('offers to continue it, with the routine and how far it went, and does not offer to start another', async () => {
      const kit = await open();
      const routine = await saveRoutine('Treino A', [
        item('a1', 'supino-reto', 0, { targetSets: 2 }),
        item('a2', 'agachamento', 1, { targetSets: 1 }),
      ]);
      const sessions = TestBed.inject(SessionRepository);
      await sessions.start(routine.id);
      await sessions.addSet({ exerciseId: 'supino-reto', weightKg: 40, reps: 10 });
      const { el, fixture } = await show(kit);

      await eventually(fixture, () => expect(text(el)).toContain('Treino em Andamento'));
      expect(text(el)).toContain('Treino A');
      expect(text(el)).toContain('1 de 3 séries');
      expect(buttons(el).some((node) => node.textContent?.includes('Iniciar Treino'))).toBe(false);

      button(el, 'Continuar Treino').click();
      await eventually(fixture, () => expect(TestBed.inject(Router).url).toBe('/treino/sessao'));
    });
  });

  describe('the workout', () => {
    /** Inicia o treino e para na tela do dia (a lista de exercícios), antes de abrir um exercício. */
    async function atDay() {
      const kit = await open();
      await seedHistory(kit.trainingDb, 'supino-reto', [[1, 40, 10]]);
      await saveRoutine('Treino A', [
        item('a1', 'supino-reto', 0, { targetSets: 2, restSeconds: 120 }),
        item('a2', 'agachamento', 1, { targetSets: 1 }),
      ]);
      const view = await show(kit);
      await eventually(view.fixture, () => expect(button(view.el, 'Iniciar Treino')).toBeDefined());
      button(view.el, 'Iniciar Treino').click();
      // Sem programa semanal, iniciar oferece a escolha; estes testes seguem sem programa.
      await eventually(view.fixture, () =>
        expect(button(view.el, 'Seguir sem Programa')).toBeDefined(),
      );
      button(view.el, 'Seguir sem Programa').click();
      await eventually(view.fixture, () =>
        expect(kit.harness.routeNativeElement?.matches('app-workout-day')).toBe(true),
      );
      await eventually(view.fixture, () =>
        expect(kit.harness.routeNativeElement?.querySelector('.exercise')).not.toBeNull(),
      );
      return { ...kit, el: kit.harness.routeNativeElement as HTMLElement, fixture: view.fixture };
    }

    async function started() {
      const kit = await atDay();
      kit.el.querySelector<HTMLButtonElement>('.exercise')!.click();
      await eventually(kit.fixture, () =>
        expect(kit.harness.routeNativeElement?.matches('app-workout-exercise')).toBe(true),
      );
      return { ...kit, el: kit.harness.routeNativeElement as HTMLElement };
    }

    it('shows the day screen with the compact name, one photo card per exercise and the options menu', async () => {
      const { el, fixture } = await atDay();

      expect(el.querySelector('.routine-name')?.textContent?.trim()).toBe('Treino A');
      expect(el.querySelectorAll('.exercise')).toHaveLength(2);
      expect(el.querySelector('.exercise.suggested')?.textContent).toContain(
        'Supino reto com barra',
      );

      openHeaderMenu('workout-menu');
      await eventually(fixture, () =>
        expect(button(document.body, 'Adicionar Exercício')).toBeDefined(),
      );
      expect(button(document.body, 'Cancelar Treino')).toBeDefined();
      // A lista dos exercícios é a própria tela: a linha que a abriria não aparece aqui.
      expect(
        buttons(document.body).some((node) => node.textContent?.includes('Exercícios do Treino')),
      ).toBe(false);
    });

    it('goes back to the day screen when the last set of an exercise is concluded', async () => {
      const kit = await started();
      const { el, fixture } = kit;
      await eventually(fixture, () => expect(text(el)).toContain('Última Vez e Sugestão'));
      await eventually(fixture, () => expect(button(el, 'Concluir Série').disabled).toBe(false));

      kit.runtime.advance(DOUBLE_TAP_MS + 100);
      button(el, 'Concluir Série').click();
      await eventually(fixture, () => expect(text(el)).toContain('Série 2 de 2'));
      await eventually(fixture, () => expect(button(el, 'Concluir Série').disabled).toBe(false));
      // O voltar desfaz a entrada do registro no histórico (a lista do dia era a anterior).
      const back = vi.spyOn(TestBed.inject(Location), 'back');
      kit.runtime.advance(DOUBLE_TAP_MS + 100);
      button(el, 'Concluir Série').click();

      await eventually(fixture, () => expect(back).toHaveBeenCalledOnce());
      // A última série do exercício não deixa descanso guardado para o próximo exercício.
      expect(TestBed.inject(RestTimerService).active()).toBe(false);
    });

    it('ending the exercise from the rest card stops the clock, so the next exercise does not open resting', async () => {
      const kit = await started();
      const { el, fixture } = kit;
      await eventually(fixture, () => expect(text(el)).toContain('Última Vez e Sugestão'));
      await eventually(fixture, () => expect(button(el, 'Concluir Série').disabled).toBe(false));
      kit.runtime.advance(DOUBLE_TAP_MS + 100);
      button(el, 'Concluir Série').click();
      await eventually(fixture, () => expect(el.querySelector('.rest')).not.toBeNull());
      expect(TestBed.inject(RestTimerService).active()).toBe(true);

      const back = vi.spyOn(TestBed.inject(Location), 'back');
      button(el, 'Encerrar Exercício').click();

      await eventually(fixture, () => expect(back).toHaveBeenCalledOnce());
      expect(TestBed.inject(RestTimerService).active()).toBe(false);
    });

    it('opens the live screen with the routine, the exercise, the numbers of last time and one main button', async () => {
      const { el, fixture } = await started();

      await eventually(fixture, () => expect(text(el)).toContain('Supino reto com barra'));
      expect(el.querySelector('app-live-session h2')?.textContent).toContain('Treino');
      expect(text(el)).toContain('Série 1 de 2');
      await eventually(fixture, () => expect(text(el)).toContain('Última Vez e Sugestão'));
      // A referência fica recolhida até a pessoa tocar: o registro da série é o que importa na tela.
      const hintPanel = () => el.querySelector<HTMLElement>('app-focus-hint .panel')!;
      expect(hintPanel().hidden).toBe(true);
      button(el, 'Última Vez e Sugestão').click();
      await eventually(fixture, () => expect(hintPanel().hidden).toBe(false));
      expect(hintPanel().textContent).toContain('Última vez 40 kg × 10');
      const inputs = Array.from(el.querySelectorAll<HTMLInputElement>('app-live-stepper input'));
      expect(inputs.map((input) => input.value)).toEqual(['40', '10']);
      expect(button(el, 'Concluir Série')).toBeDefined();
    });

    it('concludes a set: it is saved, the rest card appears, and skip closes it', async () => {
      const kit = await started();
      const { el, fixture } = kit;
      await eventually(fixture, () => expect(text(el)).toContain('Última Vez e Sugestão'));

      kit.runtime.advance(DOUBLE_TAP_MS + 100);
      button(el, 'Concluir Série').click();

      await eventually(fixture, () => expect(text(el)).toContain('Descanso'));
      expect(text(el)).toContain('2:00');
      await eventually(fixture, () => expect(text(el)).toContain('meta 2:00'));
      await eventually(fixture, () => expect(text(el)).toContain('Série 2 de 2'));
      const sets = await TestBed.inject(SessionRepository).setsOfSession(
        (await TestBed.inject(SessionRepository).activeSession())!.id,
      );
      expect(sets).toHaveLength(1);
      expect(sets[0]).toMatchObject({ exerciseId: 'supino-reto', weightKg: 40, reps: 10 });

      button(el, 'Pular Descanso').click();
      await eventually(fixture, () => expect(el.querySelector('.rest')).toBeNull());
    });

    it('keeps the effort (RPE) optional: the same number again clears it, and a chosen one is saved', async () => {
      const kit = await started();
      const { el, fixture } = kit;
      await eventually(fixture, () => expect(text(el)).toContain('Última Vez e Sugestão'));
      const repository = TestBed.inject(SessionRepository);
      const rpe8 = () =>
        Array.from(el.querySelectorAll<HTMLButtonElement>('.rpe-button')).find(
          (node) => node.textContent?.trim() === '8',
        )!;
      // O esforço nasce recolhido: só o botão "Esforço (RPE) opcional" está na tela.
      const rpePanel = () => el.querySelector<HTMLElement>('.rpe')!;
      expect(rpePanel().hidden).toBe(true);
      expect(button(el, 'Esforço (RPE) opcional').getAttribute('aria-expanded')).toBe('false');
      button(el, 'Esforço (RPE) opcional').click();
      await eventually(fixture, () => expect(rpePanel().hidden).toBe(false));
      expect(el.querySelector('.rpe-button[aria-pressed="true"]')).toBeNull();

      rpe8().click();
      await eventually(fixture, () => expect(rpe8().getAttribute('aria-pressed')).toBe('true'));
      rpe8().click();
      await eventually(fixture, () => expect(rpe8().getAttribute('aria-pressed')).toBe('false'));
      kit.runtime.advance(DOUBLE_TAP_MS + 100);
      button(el, 'Concluir Série').click();
      await eventually(fixture, () => expect(text(el)).toContain('Série 2 de 2'));

      // Na série seguinte o esforço volta recolhido, sem a escolha da anterior.
      await eventually(fixture, () => expect(rpePanel().hidden).toBe(true));
      expect(button(el, 'Esforço (RPE) opcional').getAttribute('aria-expanded')).toBe('false');
      button(el, 'Esforço (RPE) opcional').click();
      await eventually(fixture, () => expect(rpePanel().hidden).toBe(false));
      expect(el.querySelector('.rpe-button[aria-pressed="true"]')).toBeNull();

      rpe8().click();
      kit.runtime.advance(DOUBLE_TAP_MS + 100);
      await eventually(fixture, () => expect(rpe8().getAttribute('aria-pressed')).toBe('true'));
      // O botão fica desligado enquanto a série anterior ainda termina de ser gravada e relida: espera-se por ele.
      await eventually(fixture, () => expect(button(el, 'Concluir Série').disabled).toBe(false));
      button(el, 'Concluir Série').click();
      const id = (await repository.activeSession())!.id;
      await vi.waitFor(async () => expect(await repository.setsOfSession(id)).toHaveLength(2));
      const sets = await repository.setsOfSession(id);
      expect(sets.map((set) => set.rpe)).toEqual([null, 8]);
    });

    it('tells a device that cannot vibrate (the iPhone) that the end of rest is only on screen, and one that can that it will vibrate', async () => {
      const without = await started();
      await eventually(without.fixture, () =>
        expect(text(without.el)).toContain('Última Vez e Sugestão'),
      );
      without.runtime.advance(DOUBLE_TAP_MS + 100);
      button(without.el, 'Concluir Série').click();
      await eventually(without.fixture, () =>
        expect(text(without.el)).toContain('Sem vibração: olhe a tela.'),
      );
      TestBed.resetTestingModule();

      Object.defineProperty(navigator, 'vibrate', { configurable: true, value: () => true });
      try {
        const withVibration = await started();
        await eventually(withVibration.fixture, () =>
          expect(text(withVibration.el)).toContain('Última Vez e Sugestão'),
        );
        withVibration.runtime.advance(DOUBLE_TAP_MS + 100);
        button(withVibration.el, 'Concluir Série').click();
        await eventually(withVibration.fixture, () =>
          expect(text(withVibration.el)).toContain('Vibra no fim.'),
        );
      } finally {
        delete (navigator as unknown as Record<string, unknown>)['vibrate'];
      }
    });

    it('puts the keep-screen-on switch on the workout screen, and disables it with the reason when the browser cannot', async () => {
      const { el, fixture } = await started();
      await eventually(fixture, () => expect(text(el)).toContain('Última Vez e Sugestão'));

      const toggle = el.querySelector<HTMLInputElement>('.tools input[role="switch"]')!;
      expect(toggle.checked).toBe(false);
      expect(toggle.disabled).toBe(true);
      expect(toggle.getAttribute('aria-label')).toBe(
        'Manter a Tela Acesa (indisponível neste navegador)',
      );

      // O menu do treino não repete o interruptor.
      openHeaderMenu('live-menu');
      await eventually(fixture, () => expect(button(el, 'Cancelar Treino')).toBeDefined());
      expect(el.querySelector('dialog input[role="switch"]')).toBeNull();
    });

    it('says how many sets still wait to be sent, and reads "rest is over" in a polite region', async () => {
      const kit = await started();
      const { el, fixture } = kit;
      await eventually(fixture, () => expect(text(el)).toContain('Última Vez e Sugestão'));
      expect(el.querySelector('.sending')).toBeNull();

      kit.runtime.advance(DOUBLE_TAP_MS + 100);
      button(el, 'Concluir Série').click();
      await eventually(fixture, () => expect(text(el)).toContain('1 série aguardando envio'));

      const region = el.querySelector('p.ui-visually-hidden[role="status"]')!;
      expect(region.textContent).toBe('');
      kit.runtime.advance(125_000);
      await eventually(fixture, () => expect(region.textContent).toBe('Descanso terminou'));
    });

    it('ends the workout from the menu and shows the summary with the numbers done by hand', async () => {
      const kit = await started();
      const { el, fixture } = kit;
      await eventually(fixture, () => expect(text(el)).toContain('Última Vez e Sugestão'));
      kit.runtime.advance(DOUBLE_TAP_MS + 100);
      button(el, 'Concluir Série').click();
      await eventually(fixture, () => expect(text(el)).toContain('Série 2 de 2'));

      openHeaderMenu('live-menu');
      await eventually(fixture, () => expect(button(el, 'Terminar Treino')).toBeDefined());
      button(el, 'Terminar Treino').click();

      // O resumo é outra rota: a tela do registro já saiu de cena.
      const summary = () => kit.harness.routeNativeElement as HTMLElement;
      await eventually(fixture, () => expect(text(summary())).toContain('Treino Concluído'));
      const stats = Array.from(summary().querySelectorAll('.stat')).map((node) => text(node));
      // 40 kg × 10 repetições = 400 kg; uma série de trabalho; nenhum recorde (igualou a última vez).
      expect(stats[0]).toContain('400 kg');
      expect(stats[2]).toContain('1');
      expect(stats[3]).toContain('0');
      expect(text(summary())).toContain('Salvo no aparelho');
      // A seta do topo da casca fecha o resumo, em vez de sair de Hoje.
      expect(TestBed.inject(TrainingHeaderActions).backHandler()).not.toBeNull();
      expect(summary().querySelector('.ui-switch')).toBeNull();
    });
  });
});
