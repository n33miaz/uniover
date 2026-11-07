import { TestBed } from '@angular/core/testing';
import { AccountScope } from '../../../core/session/account-scope';
import type { FakeAccountScope } from '../../../core/offline-queue/queue-test-kit';
import { provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { routineDto } from '../data/routines/routine-data-test-kit';
import { RoutineRepository } from '../data/routines/routine-repository';
import { isoWeekday } from '../domain/routines/week-plan';
import { FIRST_PULL_WAIT_MS, TrainingSync } from '../data/sync/training-sync';
import { exerciseDto, localExercise, setupTraining } from '../data/sync/training-test-kit';
import { FIRST_PULL_NEEDS } from '../shell/first-pull';
import { eventually, item, saveRoutine } from '../shell/screen-test-kit';
import { TodayPage } from './today.page';

const EMPTY = 'Sem Rotinas Ainda';

/** Meio-dia local de cada dia da semana (1 = segunda ... 7 = domingo), numa semana qualquer fixa. */
const NOON_OF_WEEKDAY = (weekday: number) => new Date(2025, 9, 5 + weekday, 12).getTime();
const WEEKDAYS = [1, 2, 3, 4, 5, 6, 7];

/** Uma etapa da primeira passada que só termina quando o teste solta. */
function step<T>(value: () => T | Promise<T>) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  return { run: async () => (await gate, value()), release };
}

/**
 * Na primeira abertura de um aparelho sem nada o servidor traz o catálogo, depois as rotinas, depois o resto. Entre uma
 * etapa e outra o banco local está pela metade, e a tela de Hoje não pode tratar isso como "não há rotinas".
 */
describe('Today on a device that has never pulled', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  async function open(
    withCatalog = false,
    options: {
      waitMs?: number;
      noSession?: boolean;
      seed?: () => Promise<void>;
      /** Instante do relógio do aparelho (o mesmo que a tela de Hoje lê); sem ele vale o relógio falso padrão. */
      now?: number;
    } = {},
  ) {
    TestBed.configureTestingModule({
      providers: [
        provideRouter([{ path: 'treino', component: TodayPage }]),
        ...(options.waitMs === undefined
          ? []
          : [{ provide: FIRST_PULL_WAIT_MS, useValue: options.waitMs }]),
      ],
    });
    const kit = setupTraining();
    kit.pause();
    if (options.now !== undefined) kit.runtime.time = options.now;
    if (options.noSession)
      (TestBed.inject(AccountScope) as unknown as FakeAccountScope).sessionAccount.set(null);
    localStorage.clear();
    if (withCatalog) await kit.trainingDb.exercises.bulkPut([localExercise('supino-reto')]);
    await options.seed?.();
    const harness = await RouterTestingHarness.create();
    await harness.navigateByUrl('/treino', TodayPage);
    const el = harness.routeNativeElement as HTMLElement;
    // Todo estado em que a tela já mostrou o vazio falso, mesmo que por um quadro.
    let sawEmpty = false;
    const watcher = new MutationObserver(() => {
      if (el.textContent?.includes(EMPTY)) sawEmpty = true;
    });
    watcher.observe(el, { childList: true, subtree: true, characterData: true });
    let sawDownloading = false;
    const downloading = new MutationObserver(() => {
      if (el.textContent?.includes('Baixando o catálogo…')) sawDownloading = true;
    });
    downloading.observe(el, { childList: true, subtree: true, characterData: true });
    return {
      kit,
      harness,
      el,
      sawEmpty: () => sawEmpty,
      sawDownloading: () => sawDownloading,
      stop: () => {
        watcher.disconnect();
        downloading.disconnect();
      },
    };
  }

  // Hoje vem do relógio do aparelho (o falso do teste), e não do relógio real: o resultado não pode depender do dia em que o
  // teste roda, nem cair num dia de descanso. Cobre os sete dias da semana.
  it.each(WEEKDAYS)(
    'waits for the routines, the program, the workouts, the sets and the catalog, and never shows the empty state or the wrong day while they arrive (weekday %i)',
    async (weekday) => {
      const { kit, harness, el, sawEmpty, stop } = await open(false, {
        now: NOON_OF_WEEKDAY(weekday),
      });
      const fixture = harness.fixture;
      // Duas fichas de um programa: a de hoje é a "Treino B"; a "Treino A" é de outro dia da semana.
      const today = isoWeekday(kit.runtime.now());
      expect(today).toBe(weekday);
      const other = (today % 7) + 1;
      const routinesPage = step(() => ({
        items: [
          routineDto('r-a', { name: 'Treino A', position: 0, programId: 'p1', weekdays: [other] }),
          routineDto('r-b', { name: 'Treino B', position: 1, programId: 'p1', weekdays: [today] }),
        ],
        nextCursor: 'c1',
      }));
      const programPage = step(() => ({
        items: [
          {
            programId: 'p1',
            updatedAt: '2026-10-01T10:00:00Z',
            clientUpdatedAt: '2026-10-01T10:00:00Z',
          },
        ],
        nextCursor: 'c1',
      }));
      const sessionsPage = step(() => ({ items: [], nextCursor: null }));
      const setsPage = step(() => ({ items: [], nextCursor: null }));
      const catalogPage = step(() => ({
        items: [exerciseDto('supino-reto', { name: 'Supino reto' })],
        nextCursor: 'c1',
      }));
      // A meta da semana vem depois do que Hoje decide: a tela não espera por ela.
      const goalsPage = step(() => ({ items: [], nextCursor: null }));
      kit.pull.script = [
        routinesPage.run,
        programPage.run,
        sessionsPage.run,
        setsPage.run,
        catalogPage.run,
        goalsPage.run,
      ];
      // O cartão do dia (a faixa da semana embaixo mostra as fichas do programa e se atualiza sozinha).
      const card = () => el.querySelector('section.routine')?.textContent ?? '';
      // Todo quadro em que a tela mostrou uma ficha antes de a ficha de hoje estar decidida.
      let sawWrongDay = false;
      const wrongDay = new MutationObserver(() => {
        if (card().includes('Treino A')) sawWrongDay = true;
      });
      wrongDay.observe(el, { childList: true, subtree: true, characterData: true });
      const sync = TestBed.inject(TrainingSync);
      const pass = sync.start();
      const waiting = () => {
        expect(el.textContent).toContain('Baixando o catálogo…');
        expect(el.textContent).not.toContain(EMPTY);
        expect(card()).not.toContain('Treino A');
        expect(card()).not.toContain('Treino B');
      };

      await eventually(fixture, waiting);
      expect(kit.pull.calls.map((call) => call.path)).toEqual(['/api/v1/training/routines']);

      // As rotinas já estão no aparelho, o programa que diz qual é a de hoje ainda não.
      routinesPage.release();
      await vi.waitFor(async () => expect(await kit.trainingDb.routines.count()).toBe(2));
      await eventually(fixture, waiting);

      programPage.release();
      await vi.waitFor(async () => expect(await kit.trainingDb.program.count()).toBe(1));
      await eventually(fixture, waiting);

      sessionsPage.release();
      setsPage.release();
      await vi.waitFor(() => expect(kit.pull.calls).toHaveLength(5));
      // Só falta o catálogo (os nomes dos exercícios do cartão): a espera segue.
      await eventually(fixture, waiting);
      expect(kit.pull.calls.map((call) => call.path.replace('/api/v1/training/', ''))).toEqual([
        'routines',
        'program',
        'sessions',
        'sets',
        'exercises',
      ]);

      catalogPage.release();
      await vi.waitFor(() => expect(kit.pull.calls.length).toBeGreaterThanOrEqual(6));
      // A passada ainda não acabou (a meta da semana pende), mas Hoje já decidiu: a ficha de hoje, e só ela.
      await eventually(fixture, () => {
        expect(card()).toContain('Treino B');
        expect(el.textContent).not.toContain('Baixando o catálogo…');
      });
      expect(sync.firstPassSettled()).toBe(false);
      expect(card()).not.toContain('Treino A');

      goalsPage.release();
      await pass;
      await eventually(fixture, () => expect(card()).toContain('Treino B'));
      expect(sawEmpty()).toBe(false);
      expect(sawWrongDay).toBe(false);
      wrongDay.disconnect();
      stop();
    },
  );

  it('holds the wait after the pull ended until a read that started after it has emitted', async () => {
    const original = RoutineRepository.prototype.all;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let settledReads = 0;
    vi.spyOn(RoutineRepository.prototype, 'all').mockImplementation(async function (
      this: RoutineRepository,
    ) {
      // As leituras anteriores ao fim da espera (o que Hoje lê já puxado) seguem normais; a primeira depois dele fica presa.
      if (TestBed.inject(TrainingSync).resourcesPulled(FIRST_PULL_NEEDS.today)) {
        settledReads++;
        await gate;
      }
      return original.call(this);
    });
    // O catálogo já veio: sem rotinas, o vazio é o estado certo (e não o aviso de catálogo ausente).
    const { harness, el, sawEmpty, stop } = await open(true);
    const fixture = harness.fixture;
    const sync = TestBed.inject(TrainingSync);
    await sync.start();
    expect(sync.firstPassSettled()).toBe(true);
    await vi.waitFor(() => expect(settledReads).toBeGreaterThan(0));

    // A passada acabou, mas a leitura que a segue ainda não voltou: nada de vazio falso.
    await eventually(fixture, () => {
      expect(el.textContent).toContain('Baixando o catálogo…');
      expect(el.textContent).not.toContain(EMPTY);
    });

    release();
    // Conta sem rotinas de verdade: só agora o vazio é verdadeiro.
    await eventually(fixture, () => expect(el.textContent).toContain(EMPTY));
    expect(el.textContent).not.toContain('Baixando o catálogo…');
    expect(sawEmpty()).toBe(true);
    stop();
  });

  it('does not wait forever when there is no valid session: with the catalog already here the empty state shows at once', async () => {
    const { harness, el, sawDownloading, stop } = await open(true, { noSession: true });
    await TestBed.inject(TrainingSync).start();
    // Sem sessão a passada nunca puxa e nunca "acaba"; a espera não pode segurar o treino.
    await eventually(harness.fixture, () => expect(el.textContent).toContain(EMPTY));
    expect(sawDownloading()).toBe(false);
    stop();
  });

  it('gives up waiting after the cap when there is no session and the catalog is still missing', async () => {
    const { harness, el, stop } = await open(false, { noSession: true, waitMs: 400 });
    await TestBed.inject(TrainingSync).start();
    await eventually(harness.fixture, () =>
      expect(el.textContent).toContain('Baixando o catálogo…'),
    );
    await eventually(harness.fixture, () => {
      expect(el.textContent).toContain('O Catálogo Ainda Não Chegou');
      expect(el.textContent).not.toContain('Baixando o catálogo…');
    });
    stop();
  });

  it('never flashes the download wait for a device that already has data while the first read of the last pull is still going', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    vi.spyOn(
      TrainingSync.prototype as unknown as { readLastPullAt(): Promise<number | null> },
      'readLastPullAt',
    ).mockImplementation(async () => {
      await gate;
      return 1_760_000_000_000;
    });
    const { harness, el, sawEmpty, sawDownloading, stop } = await open(true, {
      seed: async () => void (await saveRoutine('Treino A', [item('a1', 'supino-reto', 0)])),
    });
    void TestBed.inject(TrainingSync).start();
    // Enquanto não se sabe se o aparelho é novo, a tela espera com o esqueleto, sem vazio e sem "Baixando".
    await vi.waitFor(() => expect(el.querySelector('app-today-skeleton')).not.toBeNull());
    expect(el.textContent).not.toContain(EMPTY);
    expect(el.textContent).not.toContain('Baixando o catálogo…');

    release();
    await eventually(harness.fixture, () => expect(el.textContent).toContain('Treino A'));
    expect(sawDownloading()).toBe(false);
    expect(sawEmpty()).toBe(false);
    stop();
  });
});
