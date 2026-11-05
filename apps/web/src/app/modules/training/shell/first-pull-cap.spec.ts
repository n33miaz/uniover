import { Type } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BodyPage } from '../body/body.page';
import { CatalogRepository } from '../data/catalog/catalog-repository';
import { FIRST_PULL_MAX_MS, FIRST_PULL_WAIT_MS, TrainingSync } from '../data/sync/training-sync';
import { exerciseDto, localExercise, setupTraining } from '../data/sync/training-test-kit';
import { ProgressPage } from '../progress/progress.page';
import { RoutinesListPage } from '../routines/routines-list.page';
import { TodayPage } from '../today/today.page';

/**
 * A espera da primeira passada tem um teto único (`FIRST_PULL_WAIT_MS`, no puxador) que vale para toda tela que depende de
 * `awaitingFirstPull`: uma requisição pendurada (portal cativo, TCP sem resposta) não pode deixar o esqueleto para sempre, e
 * o prazo só corre quando a passada pode começar, não enquanto o banco e a fila ainda estão sendo lidos.
 */
const WAIT = 8_000;
/** O teto de partida padrão (ver `FIRST_PULL_BOOT_MAX_MS`). */
const FIRST_PULL_BOOT_MAX_MS_DEFAULT = 30_000;
/** O teto absoluto padrão da passada (ver `FIRST_PULL_MAX_MS`). */
const FIRST_PULL_MAX_MS_DEFAULT = 45_000;

// Os relógios do navegador de teste ficam falsos só para `setTimeout`/`clearTimeout`: o IndexedDB falso e as leituras
// seguem no relógio real. O relógio real é guardado antes, para o teste poder esperar I/O sem mover o falso.
const realSetTimeout = globalThis.setTimeout.bind(globalThis);
const io = () => new Promise<void>((resolve) => realSetTimeout(resolve, 25));

async function settleIo(fixture: ComponentFixture<unknown>, rounds = 12): Promise<void> {
  for (let round = 0; round < rounds; round++) {
    await io();
    fixture.detectChanges();
  }
}

async function until(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    TestBed.tick();
    if (check()) return;
    await io();
  }
  throw new Error('condition not reached');
}

interface Screen {
  readonly name: string;
  readonly page: Type<unknown>;
  /** A tela ainda está na espera (esqueleto, ou o "Baixando" de Hoje). */
  readonly waiting: (el: HTMLElement) => boolean;
}

const hasSkeleton = (tag: string) => (el: HTMLElement) => el.querySelector(tag) !== null;

const SCREENS: readonly Screen[] = [
  { name: 'Rotinas', page: RoutinesListPage, waiting: hasSkeleton('app-routines-list-skeleton') },
  { name: 'Progresso', page: ProgressPage, waiting: hasSkeleton('app-progress-skeleton') },
  { name: 'Corpo', page: BodyPage, waiting: hasSkeleton('app-body-skeleton') },
  {
    name: 'Hoje',
    page: TodayPage,
    waiting: (el) =>
      el.querySelector('app-today-skeleton') !== null ||
      (el.textContent ?? '').includes('Baixando o catálogo…'),
  },
];

describe('the first-pull wait cap', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    localStorage.clear();
  });

  /** Aparelho novo, com rede e sessão, cujo primeiro pedido ao servidor nunca responde. */
  function openHung(page: Type<unknown>) {
    const kit = setupTraining();
    TestBed.configureTestingModule({ providers: [provideRouter([])] });
    kit.pause();
    // Hoje, com o catálogo ausente, mostraria um aviso próprio; aqui o que importa é o esqueleto sair.
    void kit.trainingDb.exercises.bulkPut([localExercise('supino-reto')]);
    kit.pull.gate = new Promise<void>(() => undefined);
    const fixture = TestBed.createComponent(page);
    fixture.detectChanges();
    return { kit, fixture, el: fixture.nativeElement as HTMLElement };
  }

  describe.each(SCREENS)('$name', ({ page, waiting }) => {
    it('releases the skeleton after the cap when the first request hangs', async () => {
      const { kit, fixture, el } = openHung(page);
      const sync = TestBed.inject(TrainingSync);
      void sync.start();
      await until(() => kit.pull.calls.length === 1);
      await settleIo(fixture);
      expect(sync.firstPassSettled()).toBe(false);
      expect(waiting(el)).toBe(true);

      vi.advanceTimersByTime(WAIT - 1);
      await settleIo(fixture, 4);
      expect(waiting(el)).toBe(true);

      vi.advanceTimersByTime(1);
      await settleIo(fixture);
      expect(sync.firstPullWaitExpired()).toBe(true);
      expect(waiting(el)).toBe(false);
    });

    it('does not spend the deadline while the hydration before the pull is slow', async () => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      vi.spyOn(
        TrainingSync.prototype as unknown as { readLastPullAt(): Promise<number | null> },
        'readLastPullAt',
      ).mockImplementation(async () => {
        await gate;
        return null;
      });
      const { kit, fixture, el } = openHung(page);
      const sync = TestBed.inject(TrainingSync);
      void sync.start();

      // Bem mais que o prazo da passada, e menos que o teto de partida: o prazo não corre, a tela segue no esqueleto.
      vi.advanceTimersByTime(WAIT * 2);
      await settleIo(fixture, 4);
      expect(kit.pull.calls.length).toBe(0);
      expect(sync.firstPullWaitExpired()).toBe(false);
      expect(waiting(el)).toBe(true);

      // A hidratação acaba: só agora o prazo da passada começa a contar.
      release();
      await until(() => kit.pull.calls.length === 1);
      await settleIo(fixture);
      expect(waiting(el)).toBe(true);
      vi.advanceTimersByTime(WAIT - 1);
      await settleIo(fixture, 4);
      expect(sync.firstPullWaitExpired()).toBe(false);
      expect(waiting(el)).toBe(true);

      vi.advanceTimersByTime(1);
      await settleIo(fixture);
      expect(sync.firstPullWaitExpired()).toBe(true);
      expect(waiting(el)).toBe(false);
    });
  });
});

describe('the first-pull wait cap in the sync', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('still has an upper bound when the pull can never start (hydration hangs forever)', async () => {
    vi.spyOn(
      TrainingSync.prototype as unknown as { readLastPullAt(): Promise<number | null> },
      'readLastPullAt',
    ).mockImplementation(() => new Promise<never>(() => undefined));
    const kit = setupTraining();
    kit.pause();
    const sync = TestBed.inject(TrainingSync);
    void sync.start();

    vi.advanceTimersByTime(FIRST_PULL_BOOT_MAX_MS_DEFAULT - 1);
    expect(sync.firstPullWaitExpired()).toBe(false);
    vi.advanceTimersByTime(1);
    expect(sync.firstPullWaitExpired()).toBe(true);
    expect(kit.pull.calls.length).toBe(0);
  });

  it('never expires after a normal first pass, however long the screen stays open', async () => {
    const kit = setupTraining();
    kit.pause();
    const sync = TestBed.inject(TrainingSync);
    void sync.start();
    await until(() => sync.firstPassSettled());

    vi.advanceTimersByTime(FIRST_PULL_BOOT_MAX_MS_DEFAULT * 2);
    expect(sync.firstPullWaitExpired()).toBe(false);
  });

  it('uses the configured cap, counted from when the pass starts', async () => {
    const kit = setupTraining();
    TestBed.configureTestingModule({ providers: [{ provide: FIRST_PULL_WAIT_MS, useValue: 500 }] });
    kit.pause();
    kit.pull.gate = new Promise<void>(() => undefined);
    const sync = TestBed.inject(TrainingSync);
    void sync.start();
    await until(() => kit.pull.calls.length === 1);

    vi.advanceTimersByTime(499);
    expect(sync.firstPullWaitExpired()).toBe(false);
    vi.advanceTimersByTime(1);
    expect(sync.firstPullWaitExpired()).toBe(true);
  });
});

describe(
  'the first-pull wait cap follows the silence of the network, not the clock of the pass',
  { timeout: 30_000 },
  () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    });
    afterEach(() => {
      vi.restoreAllMocks();
      vi.useRealTimers();
    });

    const empty = { items: [], nextCursor: null };
    /** Uma resposta que só chega depois de `ms` (no relógio falso). */
    const after =
      (ms: number, page: unknown = empty) =>
      () =>
        new Promise<never>((resolve) => setTimeout(() => resolve(page as never), ms));
    const hang = () => new Promise<never>(() => undefined);

    /** Avança o relógio falso e deixa o I/O real (banco falso, promessas) andar. */
    async function advance(ms: number): Promise<void> {
      vi.advanceTimersByTime(ms);
      await io();
      await io();
    }

    it('does not expire while every response arrives inside the silence limit, however long the pass takes in all', async () => {
      const kit = setupTraining();
      kit.pause();
      kit.pull.script = Array.from({ length: 5 }, () => after(WAIT - 1_000));
      const sync = TestBed.inject(TrainingSync);
      void sync.start();
      await until(() => kit.pull.calls.length === 1);

      // Cinco respostas, 7 s cada: 35 s no total, muito mais que o prazo de 8 s, e a cada uma o prazo recomeça.
      for (let answered = 1; answered <= 5; answered++) {
        await advance(WAIT - 1_000);
        await until(() => kit.pull.calls.length >= answered + 1);
        expect(sync.firstPullWaitExpired()).toBe(false);
      }
      await until(() => sync.firstPassSettled());
      expect(sync.firstPullWaitExpired()).toBe(false);
    });

    it('releases 8 s after the last sign of life, not 8 s after the pass started', async () => {
      const kit = setupTraining();
      kit.pause();
      kit.pull.script = [after(5_000), hang];
      const sync = TestBed.inject(TrainingSync);
      void sync.start();
      await until(() => kit.pull.calls.length === 1);

      await advance(5_000);
      await until(() => kit.pull.calls.length === 2);
      // 13 s desde o começo, mas só 0 s desde a última resposta.
      await advance(WAIT - 1);
      expect(sync.firstPullWaitExpired()).toBe(false);
      await advance(1);
      expect(sync.firstPullWaitExpired()).toBe(true);
      expect(sync.firstPassSettled()).toBe(false);
    });

    it('does not count the time the device spends writing what arrived (a slow catalog write is not a silent network)', async () => {
      const kit = setupTraining();
      kit.pause();
      let finishWrite!: () => void;
      const write = new Promise<void>((resolve) => (finishWrite = resolve));
      vi.spyOn(CatalogRepository.prototype, 'applyRemote').mockImplementation(() => write);
      kit.pull.script = [{ items: [exerciseDto('a')], nextCursor: 'c1' }];
      const sync = TestBed.inject(TrainingSync);
      void sync.start();
      await until(() => kit.pull.calls.length === 1);
      await advance(0);

      // A escrita dura 3 vezes o prazo de silêncio (a medida em produção foi de 9,5 s): a rede não está muda, o aparelho trabalha.
      await advance(WAIT * 3);
      expect(sync.firstPullWaitExpired()).toBe(false);
      expect(sync.resourcesPulled(['exercises'])).toBe(false);

      finishWrite();
      await until(() => sync.resourcesPulled(['exercises']));
      await until(() => sync.firstPassSettled());
      expect(sync.firstPullWaitExpired()).toBe(false);
    });

    it('starts the silence again after the write, so a request that hangs next is still released after 8 s', async () => {
      const kit = setupTraining();
      kit.pause();
      let finishWrite!: () => void;
      const write = new Promise<void>((resolve) => (finishWrite = resolve));
      vi.spyOn(CatalogRepository.prototype, 'applyRemote').mockImplementation(() => write);
      kit.pull.script = [{ items: [exerciseDto('a')], nextCursor: 'c1' }, hang];
      const sync = TestBed.inject(TrainingSync);
      void sync.start();
      await until(() => kit.pull.calls.length === 1);
      await advance(WAIT * 2);

      finishWrite();
      await until(() => kit.pull.calls.length === 2);
      await advance(WAIT - 1);
      expect(sync.firstPullWaitExpired()).toBe(false);
      await advance(1);
      expect(sync.firstPullWaitExpired()).toBe(true);
    });

    it('still has an absolute ceiling for a pass that keeps answering but never ends', async () => {
      const kit = setupTraining();
      kit.pause();
      kit.pull.script = Array.from({ length: 12 }, () => after(WAIT - 1_000));
      const sync = TestBed.inject(TrainingSync);
      void sync.start();
      await until(() => kit.pull.calls.length === 1);

      let elapsed = 0;
      for (let answered = 1; elapsed + (WAIT - 1_000) < FIRST_PULL_MAX_MS_DEFAULT; answered++) {
        await advance(WAIT - 1_000);
        elapsed += WAIT - 1_000;
        await until(() => kit.pull.calls.length === answered + 1);
        expect(sync.firstPullWaitExpired()).toBe(false);
      }
      await advance(FIRST_PULL_MAX_MS_DEFAULT - elapsed);
      expect(sync.firstPullWaitExpired()).toBe(true);
    });

    it('uses the configured ceiling, counted from when the pass starts', async () => {
      const kit = setupTraining();
      TestBed.configureTestingModule({
        providers: [
          { provide: FIRST_PULL_WAIT_MS, useValue: 500 },
          { provide: FIRST_PULL_MAX_MS, useValue: 1_200 },
        ],
      });
      kit.pause();
      kit.pull.script = Array.from({ length: 12 }, () => after(400));
      const sync = TestBed.inject(TrainingSync);
      void sync.start();
      await until(() => kit.pull.calls.length === 1);

      await advance(400);
      await advance(400);
      await advance(399);
      expect(sync.firstPullWaitExpired()).toBe(false);
      await advance(1);
      expect(sync.firstPullWaitExpired()).toBe(true);
    });
  },
);
