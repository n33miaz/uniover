import { TestBed } from '@angular/core/testing';
import { ConnectivityService } from '../../../core/connectivity/connectivity.service';
import { SessionRepository } from '../data/sessions/session-repository';
import { setupSessions } from '../data/sessions/session-data-test-kit';
import { catalog, eventually, item, saveRoutine, seedHistory } from '../shell/screen-test-kit';
import { TrainingSync } from '../data/sync/training-sync';
import { provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { DOUBLE_TAP_MS } from './live-store';
import { TodayPage } from './today.page';

const HOUR = 3_600_000;

async function open(url = '/treino') {
  TestBed.configureTestingModule({
    providers: [provideRouter([{ path: 'treino', component: TodayPage }])],
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

const text = (el: Element) => el.textContent?.replace(/\s+/g, ' ') ?? '';
const buttons = (el: ParentNode) => Array.from(el.querySelectorAll<HTMLButtonElement>('button'));
const button = (el: ParentNode, label: string) =>
  buttons(el).find((node) => node.textContent?.replace(/\s+/g, ' ').includes(label))!;

describe('TodayPage', () => {
  describe('the day', () => {
    it('says there are no routines yet, and still lets the person train without one', async () => {
      const kit = await open();
      const { el, fixture } = await show(kit);

      await eventually(fixture, () => expect(text(el)).toContain('Sem rotinas ainda'));
      expect(el.querySelector<HTMLAnchorElement>('a[href="/treino/rotinas"]')).not.toBeNull();
      expect(button(el, 'Treino livre')).toBeDefined();
    });

    it('offers the program choice when starting without a weekly program, and does not start until it is answered', async () => {
      const kit = await open();
      await saveRoutine('Treino A', [item('a1', 'supino-reto', 0)]);
      const { el, fixture } = await show(kit);

      await eventually(fixture, () => expect(button(el, 'Iniciar treino')).toBeDefined());
      button(el, 'Iniciar treino').click();

      await eventually(fixture, () =>
        expect(el.querySelector('app-training-sheet')).not.toBeNull(),
      );
      expect(text(el)).toContain('Programa da semana');
      expect(el.querySelector('app-live-session')).toBeNull();
    });

    it('puts the week on top and the routine of the day below it, with one main button above the list', async () => {
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
      expect(week.compareDocumentPosition(routine) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(text(routine)).toContain('Treino A');
      expect(text(routine)).toMatch(/3 exercícios · 10 séries · cerca de \d+ min/);
      const start = button(el, 'Iniciar treino');
      expect(start.compareDocumentPosition(el.querySelector('.lines')!)).toBe(
        Node.DOCUMENT_POSITION_FOLLOWING,
      );
      const rows = Array.from(el.querySelectorAll('.lines .ui-row')).map((row) => text(row));
      expect(rows[0]).toContain('4 × 6–10 · última vez 40 kg × 10');
      expect(rows[1]).toContain('supersérie');
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
        expect(text(el)).toContain('Treino aberto em outro aparelho'),
      );
      expect(text(el)).toContain('há 13 h');
      expect(buttons(el).some((node) => node.textContent?.includes('Iniciar treino'))).toBe(false);

      button(el, 'Encerrar o treino esquecido').click();
      await eventually(fixture, () => expect(text(el)).toContain('As séries dele ficam salvas'));
      button(el, 'Sim, encerrar').click();
      await eventually(fixture, () => expect(text(el)).toContain('Treino esquecido encerrado'));
      await eventually(fixture, () => expect(button(el, 'Iniciar treino')).toBeDefined());
    });

    it('asks for a connection when the catalog has not arrived yet', async () => {
      const kit = await open();
      await kit.trainingDb.exercises.clear();
      TestBed.inject(ConnectivityService).online.set(false);
      const { el, fixture } = await show(kit);

      await eventually(fixture, () => expect(text(el)).toContain('O catálogo ainda não chegou'));
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

      await eventually(fixture, () => expect(text(el)).toContain('Treino em andamento'));
      expect(text(el)).toContain('Treino A');
      expect(text(el)).toContain('1 de 3 séries');
      expect(buttons(el).some((node) => node.textContent?.includes('Iniciar treino'))).toBe(false);

      button(el, 'Continuar treino').click();
      await eventually(fixture, () => expect(el.querySelector('app-live-session')).not.toBeNull());
    });
  });

  describe('the workout', () => {
    async function started() {
      const kit = await open();
      await seedHistory(kit.trainingDb, 'supino-reto', [[1, 40, 10]]);
      await saveRoutine('Treino A', [
        item('a1', 'supino-reto', 0, { targetSets: 2, restSeconds: 120 }),
        item('a2', 'agachamento', 1, { targetSets: 1 }),
      ]);
      const view = await show(kit);
      await eventually(view.fixture, () => expect(button(view.el, 'Iniciar treino')).toBeDefined());
      button(view.el, 'Iniciar treino').click();
      // Sem programa semanal, iniciar oferece a escolha; estes testes seguem sem programa.
      await eventually(view.fixture, () =>
        expect(button(view.el, 'Seguir sem programa')).toBeDefined(),
      );
      button(view.el, 'Seguir sem programa').click();
      await eventually(view.fixture, () =>
        expect(view.el.querySelector('app-live-session')).not.toBeNull(),
      );
      return { ...kit, ...view };
    }

    it('opens the live screen with the routine, the exercise, the numbers of last time and one main button', async () => {
      const { el, fixture } = await started();

      await eventually(fixture, () => expect(text(el)).toContain('Supino reto com barra'));
      expect(el.querySelector('h1')?.textContent).toContain('Treino A');
      expect(text(el)).toContain('exercício 1 de 2 · série 1 de 2');
      await eventually(fixture, () => expect(text(el)).toContain('Última vez 40 kg × 10'));
      const inputs = Array.from(el.querySelectorAll<HTMLInputElement>('app-live-stepper input'));
      expect(inputs.map((input) => input.value)).toEqual(['40', '10']);
      expect(button(el, 'Concluir série')).toBeDefined();
    });

    it('concludes a set: it is saved, the rest card appears, and skip closes it', async () => {
      const kit = await started();
      const { el, fixture } = kit;
      await eventually(fixture, () => expect(text(el)).toContain('Última vez'));

      kit.runtime.advance(DOUBLE_TAP_MS + 100);
      button(el, 'Concluir série').click();

      await eventually(fixture, () => expect(text(el)).toContain('Descanso'));
      expect(text(el)).toContain('2:00');
      await eventually(fixture, () => expect(text(el)).toContain('meta 2:00'));
      await eventually(fixture, () => expect(text(el)).toContain('série 2 de 2'));
      const sets = await TestBed.inject(SessionRepository).setsOfSession(
        (await TestBed.inject(SessionRepository).activeSession())!.id,
      );
      expect(sets).toHaveLength(1);
      expect(sets[0]).toMatchObject({ exerciseId: 'supino-reto', weightKg: 40, reps: 10 });

      button(el, 'Pular').click();
      await eventually(fixture, () => expect(el.querySelector('.rest')).toBeNull());
    });

    it('keeps the effort (RPE) optional: the same number again clears it, and a chosen one is saved', async () => {
      const kit = await started();
      const { el, fixture } = kit;
      await eventually(fixture, () => expect(text(el)).toContain('Última vez'));
      const repository = TestBed.inject(SessionRepository);
      const rpe8 = () =>
        Array.from(el.querySelectorAll<HTMLButtonElement>('.rpe-button')).find(
          (node) => node.textContent?.trim() === '8',
        )!;
      expect(el.querySelector('.rpe-button[aria-pressed="true"]')).toBeNull();

      rpe8().click();
      await eventually(fixture, () => expect(rpe8().getAttribute('aria-pressed')).toBe('true'));
      rpe8().click();
      await eventually(fixture, () => expect(rpe8().getAttribute('aria-pressed')).toBe('false'));
      kit.runtime.advance(DOUBLE_TAP_MS + 100);
      button(el, 'Concluir série').click();
      await eventually(fixture, () => expect(text(el)).toContain('série 2 de 2'));

      rpe8().click();
      kit.runtime.advance(DOUBLE_TAP_MS + 100);
      await eventually(fixture, () => expect(rpe8().getAttribute('aria-pressed')).toBe('true'));
      // O botão fica desligado enquanto a série anterior ainda termina de ser gravada e relida: espera-se por ele.
      await eventually(fixture, () => expect(button(el, 'Concluir série').disabled).toBe(false));
      button(el, 'Concluir série').click();
      const id = (await repository.activeSession())!.id;
      await vi.waitFor(async () => expect(await repository.setsOfSession(id)).toHaveLength(2));
      const sets = await repository.setsOfSession(id);
      expect(sets.map((set) => set.rpe)).toEqual([null, 8]);
    });

    it('tells a device that cannot vibrate (the iPhone) that the end of rest is only on screen, and one that can that it will vibrate', async () => {
      const without = await started();
      await eventually(without.fixture, () => expect(text(without.el)).toContain('Última vez'));
      without.runtime.advance(DOUBLE_TAP_MS + 100);
      button(without.el, 'Concluir série').click();
      await eventually(without.fixture, () =>
        expect(text(without.el)).toContain(
          'Este aparelho não vibra: olhe a tela quando o tempo acabar.',
        ),
      );
      TestBed.resetTestingModule();

      Object.defineProperty(navigator, 'vibrate', { configurable: true, value: () => true });
      try {
        const withVibration = await started();
        await eventually(withVibration.fixture, () =>
          expect(text(withVibration.el)).toContain('Última vez'),
        );
        withVibration.runtime.advance(DOUBLE_TAP_MS + 100);
        button(withVibration.el, 'Concluir série').click();
        await eventually(withVibration.fixture, () =>
          expect(text(withVibration.el)).toContain('Vai vibrar quando terminar.'),
        );
      } finally {
        delete (navigator as unknown as Record<string, unknown>)['vibrate'];
      }
    });

    it('says in the menu that this browser cannot keep the screen on, with the literal advice, and disables the switch', async () => {
      const { el, fixture } = await started();
      await eventually(fixture, () => expect(text(el)).toContain('Última vez'));

      el.querySelector<HTMLButtonElement>('button[aria-label="Opções do treino"]')!.click();
      await eventually(fixture, () =>
        expect(text(el)).toContain('Este navegador não permite manter a tela acesa.'),
      );
      expect(text(el)).toContain('Deixe o bloqueio automático em "Nunca" durante o treino.');
      expect(el.querySelector<HTMLInputElement>('dialog input[role="switch"]')!.disabled).toBe(
        true,
      );
    });

    it('says how many sets still wait to be sent, and reads "rest is over" in a polite region', async () => {
      const kit = await started();
      const { el, fixture } = kit;
      await eventually(fixture, () => expect(text(el)).toContain('Última vez'));
      expect(el.querySelector('.sending')).toBeNull();

      kit.runtime.advance(DOUBLE_TAP_MS + 100);
      button(el, 'Concluir série').click();
      await eventually(fixture, () => expect(text(el)).toContain('1 série aguardando envio'));

      const region = el.querySelector('p.ui-visually-hidden[role="status"]')!;
      expect(region.textContent).toBe('');
      kit.runtime.advance(125_000);
      await eventually(fixture, () => expect(region.textContent).toBe('Descanso terminou'));
      expect(text(el)).toContain('Hora da próxima série.');
    });

    it('ends the workout from the menu and shows the summary with the numbers done by hand', async () => {
      const kit = await started();
      const { el, fixture } = kit;
      await eventually(fixture, () => expect(text(el)).toContain('Última vez'));
      kit.runtime.advance(DOUBLE_TAP_MS + 100);
      button(el, 'Concluir série').click();
      await eventually(fixture, () => expect(text(el)).toContain('série 2 de 2'));

      el.querySelector<HTMLButtonElement>('button[aria-label="Opções do treino"]')!.click();
      await eventually(fixture, () => expect(button(el, 'Terminar treino')).toBeDefined());
      button(el, 'Terminar treino').click();

      await eventually(fixture, () => expect(text(el)).toContain('Treino concluído'));
      const stats = Array.from(el.querySelectorAll('.stat')).map((node) => text(node));
      // 40 kg × 10 repetições = 400 kg; uma série de trabalho; nenhum recorde (igualou a última vez).
      expect(stats[0]).toContain('400 kg');
      expect(stats[2]).toContain('1');
      expect(stats[3]).toContain('0');
      expect(text(el)).toContain('Salvo no aparelho');
      expect(el.querySelector('.ui-switch')).toBeNull();
    });
  });
});
