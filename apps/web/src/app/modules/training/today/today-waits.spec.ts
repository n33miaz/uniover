import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import type { Type } from '@angular/core';
import { setupSessions } from '../data/sessions/session-data-test-kit';
import { RoutineRepository } from '../data/routines/routine-repository';
import { SessionRepository } from '../data/sessions/session-repository';
import type { LocalSession } from '../data/sessions/session';
import { TrainingSync } from '../data/sync/training-sync';
import { catalog, eventually } from '../shell/screen-test-kit';
import { TodayPage } from './today.page';
import { WorkoutDay } from './workout-day';
import { WorkoutExercise } from './workout-exercise';

/** Uma leitura do banco local que só termina quando o teste solta: é o que deixa a espera à vista. */
function hold<T>() {
  let release!: (value: T) => void;
  const gate = new Promise<T>((resolve) => (release = resolve));
  return { gate, release };
}

async function open() {
  TestBed.configureTestingModule({
    providers: [
      provideRouter([
        { path: 'treino', component: TodayPage },
        { path: 'treino/sessao', component: WorkoutDay },
        { path: 'treino/sessao/exercicio', component: WorkoutExercise },
      ]),
    ],
  });
  const kit = setupSessions();
  await TestBed.inject(TrainingSync).start();
  await kit.trainingDb.exercises.bulkPut(catalog());
  localStorage.clear();
  return RouterTestingHarness.create();
}

/** Toda espera do módulo é a moldura compartilhada: a região ocupada anunciada, com o texto que o leitor de tela ouve. */
function frameOf(el: HTMLElement, host: string) {
  const frame = el.querySelector(`${host} app-loading-frame`);
  return { frame, label: frame?.querySelector('[role="status"]')?.textContent?.trim() };
}

describe('the waits of Today and of the open workout', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  async function waitingOn(url: string, component: Type<unknown>) {
    const read = hold<LocalSession | undefined>();
    vi.spyOn(SessionRepository.prototype, 'activeSession').mockReturnValue(read.gate);
    const harness = await open();
    await harness.navigateByUrl(url, component);
    const el = harness.routeNativeElement as HTMLElement;
    harness.fixture.detectChanges();
    return { harness, el, release: () => read.release(undefined) };
  }

  it('Today draws the shape of the day, the week included, while the open workout is read, and nothing is left behind', async () => {
    const { harness, el, release } = await waitingOn('/treino', TodayPage);

    const { frame, label } = frameOf(el, 'app-today-skeleton');
    expect(frame?.getAttribute('aria-busy')).toBe('true');
    expect(label).toBe('Carregando o treino do dia…');
    expect(el.querySelector('app-today-skeleton .sk-week')).not.toBeNull();
    expect(el.querySelector('app-today-home')).toBeNull();

    release();
    await eventually(harness.fixture, () =>
      expect(el.querySelector('app-today-home')).not.toBeNull(),
    );
    await eventually(harness.fixture, () => {
      expect(el.textContent).toContain('Sem Rotinas Ainda');
      // A lista de programas também espera (e some), então a conferência é do estado final.
      expect(el.querySelector('app-loading-frame')).toBeNull();
    });
  });

  it('the card of the day waits inside Today while the routines are read, with the real week already below it', async () => {
    let release!: (routines: never[]) => void;
    vi.spyOn(RoutineRepository.prototype, 'all').mockReturnValue(
      new Promise((resolve) => (release = resolve)),
    );
    const harness = await open();
    await harness.navigateByUrl('/treino', TodayPage);
    const el = harness.routeNativeElement as HTMLElement;

    await eventually(harness.fixture, () =>
      expect(el.querySelector('app-today-home app-today-skeleton')).not.toBeNull(),
    );
    // Só o cartão do dia espera: a semana embaixo é a verdadeira, e a página não repete a dela.
    expect(el.querySelector('app-today-skeleton .sk-week')).toBeNull();
    expect(el.querySelector('app-today-home app-week-calendar .week')).not.toBeNull();

    release([]);
    await eventually(harness.fixture, () => {
      expect(el.textContent).toContain('Sem Rotinas Ainda');
      expect(el.querySelector('app-today-skeleton')).toBeNull();
    });
  });

  it('the summary view waits with the shape of the summary, not with the one of the day', async () => {
    const { el } = await waitingOn('/treino?resumo=abc', TodayPage);

    expect(el.querySelector('app-today-skeleton')).toBeNull();
    const { frame, label } = frameOf(el, 'app-session-summary-skeleton');
    expect(frame?.getAttribute('aria-busy')).toBe('true');
    expect(label).toBe('Carregando o resumo do treino…');
    expect(el.querySelectorAll('app-session-summary-skeleton .sk-stat')).toHaveLength(4);
  });

  it('the summary shows its shape while the finished workout is read, then the missing-workout notice, never an empty screen', async () => {
    const harness = await open();
    const read = hold<LocalSession | undefined>();
    vi.spyOn(SessionRepository.prototype, 'get').mockReturnValue(read.gate);
    await harness.navigateByUrl('/treino?resumo=abc', TodayPage);
    const el = harness.routeNativeElement as HTMLElement;

    await eventually(harness.fixture, () =>
      expect(el.querySelector('app-session-summary app-session-summary-skeleton')).not.toBeNull(),
    );
    expect(el.querySelector('app-session-summary h1')).toBeNull();

    read.release(undefined);
    await eventually(harness.fixture, () =>
      expect(el.textContent).toContain('Treino Não Encontrado'),
    );
    expect(el.querySelector('app-loading-frame')).toBeNull();
  });

  it('the exercise list holds the shape of its cards until the workout is read', async () => {
    const { harness, el, release } = await waitingOn('/treino/sessao', WorkoutDay);

    const { frame, label } = frameOf(el, 'app-workout-day-skeleton');
    expect(frame?.getAttribute('aria-busy')).toBe('true');
    expect(label).toBe('Carregando os exercícios do treino…');
    expect(el.querySelectorAll('app-workout-day-skeleton .sk-exercise')).toHaveLength(4);

    release();
    await eventually(harness.fixture, () =>
      expect(el.textContent).toContain('Treino Não Encontrado'),
    );
    expect(el.querySelector('app-loading-frame')).toBeNull();
  });

  it('the set screen holds its shape until the workout is read, then explains that it is over', async () => {
    const { harness, el, release } = await waitingOn('/treino/sessao/exercicio', WorkoutExercise);

    const { frame, label } = frameOf(el, 'app-live-session-skeleton');
    expect(frame?.getAttribute('aria-busy')).toBe('true');
    expect(label).toBe('Carregando o treino…');
    expect(el.querySelector('app-live-session .calm')).toBeNull();

    release();
    await eventually(harness.fixture, () =>
      expect(el.textContent).toContain('Este Treino Foi Encerrado'),
    );
    expect(el.querySelector('app-loading-frame')).toBeNull();
  });
});
