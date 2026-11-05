import { TestBed } from '@angular/core/testing';
import { AccountScope } from '../../../core/session/account-scope';
import type { FakeAccountScope } from '../../../core/offline-queue/queue-test-kit';
import { provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { RoutineRepository } from '../data/routines/routine-repository';
import { TrainingSync } from '../data/sync/training-sync';
import { exerciseDto, localExercise, setupTraining } from '../data/sync/training-test-kit';
import { eventually, item, saveRoutine } from '../shell/screen-test-kit';
import { TodayPage } from './today.page';
import { FIRST_PULL_WAIT_MS } from './today-store';

const EMPTY = 'Sem Rotinas Ainda';

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
    options: { waitMs?: number; noSession?: boolean; seed?: () => Promise<void> } = {},
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

  it('keeps waiting from the catalog arriving until the routines it brought are read, and never says there are none', async () => {
    const { kit, harness, el, sawEmpty, stop } = await open();
    const fixture = harness.fixture;
    const catalogPage = step(() => ({
      items: [exerciseDto('supino-reto', { name: 'Supino reto' })],
      nextCursor: 'c1',
    }));
    const routinesPage = step(async () => {
      // O servidor trouxe uma rotina: ela chega ao banco local no meio da passada.
      await saveRoutine('Treino A', [item('a1', 'supino-reto', 0)]);
      return { items: [], nextCursor: null };
    });
    // O que vem depois das rotinas (o programa da semana) ainda decide qual ficha é a de hoje.
    const laterPage = step(() => ({ items: [], nextCursor: null }));
    kit.pull.script = [catalogPage.run, routinesPage.run, laterPage.run];
    const sync = TestBed.inject(TrainingSync);
    const pass = sync.start();

    await eventually(fixture, () => expect(el.textContent).toContain('Baixando o catálogo…'));
    catalogPage.release();
    await vi.waitFor(async () => expect(await kit.trainingDb.exercises.count()).toBe(1));
    // O catálogo já está no aparelho, as rotinas ainda não: a espera continua.
    await eventually(fixture, () => {
      expect(el.textContent).toContain('Baixando o catálogo…');
      expect(el.textContent).not.toContain(EMPTY);
    });

    routinesPage.release();
    await vi.waitFor(() => expect(kit.pull.calls.length).toBeGreaterThanOrEqual(3));
    // A rotina já está no aparelho, mas a passada não acabou: a ficha de hoje ainda pode mudar, então ela não aparece.
    await eventually(fixture, () => {
      expect(el.textContent).toContain('Baixando o catálogo…');
      expect(el.textContent).not.toContain('Treino A');
    });

    laterPage.release();
    await pass;
    await eventually(fixture, () => {
      expect(el.textContent).toContain('Treino A');
      expect(el.textContent).not.toContain('Baixando o catálogo…');
    });
    expect(sawEmpty()).toBe(false);
    stop();
  });

  it('holds the wait after the pull ended until a read that started after it has emitted', async () => {
    const original = RoutineRepository.prototype.all;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let settledReads = 0;
    vi.spyOn(RoutineRepository.prototype, 'all').mockImplementation(async function (
      this: RoutineRepository,
    ) {
      // As leituras anteriores ao fim da passada seguem normais; a primeira depois dele fica presa.
      if (TestBed.inject(TrainingSync).firstPassSettled()) {
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
