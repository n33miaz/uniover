import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';
import { BodyRepository } from './data/body/body-repository';
import { CatalogRepository } from './data/catalog/catalog-repository';
import { MealRepository } from './data/meals/meal-repository';
import { PhysicalAssessmentRepository } from './data/physical-assessments/physical-assessment-repository';
import { eventually, setupScreen } from './shell/screen-test-kit';
import { TRAINING_ROUTES } from './training.routes';
import {
  AssessmentDetailSkeleton,
  AssessmentFormSkeleton,
  AssessmentsListSkeleton,
} from './body/assessments/assessment-skeletons';
import { BodyMealsSkeleton, BodyPhotosSkeleton, BodySkeleton } from './body/body-skeleton';
import { BodyMapSkeleton } from './exercises/body-map/body-map-skeleton';
import { ExerciseDetailSkeleton } from './exercises/detail/detail-skeleton';
import { FoodDiarySkeleton, FoodSearchSkeleton } from './foods/food-diary-skeleton';
import { ProgressChartSkeleton, ProgressSkeleton } from './progress/progress-skeleton';
import { RoutinesListSkeleton } from './routines/routines-list-skeleton';
import { TrainingFormSkeleton } from './shell/training-form-skeleton';
import { TrainingRowsSkeleton } from './shell/training-rows-skeleton';

/** Uma leitura que só termina quando o teste solta: é o que deixa a espera à vista. */
function hold<T>() {
  let release!: (value: T) => void;
  const gate = new Promise<T>((resolve) => (release = resolve));
  return { gate, release };
}

/** Toda espera do módulo é a moldura compartilhada: a região ocupada, anunciada uma vez, com o texto que o leitor de tela ouve. */
function frameOf(el: HTMLElement) {
  const frame = el.querySelector('app-loading-frame');
  return {
    frame,
    busy: frame?.getAttribute('aria-busy'),
    label: frame?.querySelector('[role="status"]')?.textContent?.trim(),
    bones: frame?.querySelectorAll('.ui-skeleton').length ?? 0,
  };
}

describe('the waits of the Training screens', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  async function open(url: string) {
    const kit = await setupScreen([
      { path: 'treino', data: { title: 'Treino' }, children: TRAINING_ROUTES },
    ]);
    const harness = await kit.harness();
    return { kit, harness, url };
  }

  /** Abre a tela com a leitura segura e devolve o que o teste precisa para olhar a espera e depois soltá-la. */
  async function waiting<T>(url: string, spy: () => void, release: (value: T) => void) {
    spy();
    const { harness } = await open(url);
    await harness.navigateByUrl(url);
    const el = harness.routeNativeElement as HTMLElement;
    harness.fixture.detectChanges();
    return { harness, el, release };
  }

  it('shows the library as shaped rows, never the "not arrived yet" notice, while the catalog is read', async () => {
    const read = hold<never[]>();
    vi.spyOn(CatalogRepository.prototype, 'search').mockReturnValue(read.gate);
    const { harness } = await open('/treino/exercicios');
    await harness.navigateByUrl('/treino/exercicios');
    const el = harness.routeNativeElement as HTMLElement;
    harness.fixture.detectChanges();

    const wait = frameOf(el);
    expect(wait.busy).toBe('true');
    expect(wait.label).toBe('Carregando os exercícios…');
    expect(el.querySelectorAll('app-training-rows-skeleton .sk-row')).toHaveLength(6);
    expect(el.querySelector('.empty')).toBeNull();

    read.release([]);
    await eventually(harness.fixture, () =>
      expect(el.querySelector('app-loading-frame')).toBeNull(),
    );
    expect(el.querySelector('.ui-skeleton')).toBeNull();
  });

  it('keeps the assessments history in a skeleton until the list arrives', async () => {
    const read = hold<[]>();
    const { harness, el } = await waiting(
      '/treino/corpo/avaliacoes',
      () =>
        void vi.spyOn(PhysicalAssessmentRepository.prototype, 'list').mockReturnValue(read.gate),
      read.release,
    );

    expect(frameOf(el).label).toBe('Carregando o histórico…');
    expect(el.querySelectorAll('app-assessments-list-skeleton .sk-record')).toHaveLength(3);
    // O cabeçalho e as ações já são os reais: só o histórico espera.
    expect(el.querySelector('#title')?.textContent).toContain('Avaliações Físicas');

    read.release([]);
    await eventually(harness.fixture, () =>
      expect(el.querySelector('app-loading-frame')).toBeNull(),
    );
    expect(el.textContent).toContain('Seu histórico começa aqui');
  });

  it('keeps an assessment in a skeleton, with its header, until it is read', async () => {
    const read = hold<undefined>();
    const { harness, el } = await waiting(
      '/treino/corpo/avaliacoes/qualquer',
      () => void vi.spyOn(PhysicalAssessmentRepository.prototype, 'get').mockReturnValue(read.gate),
      read.release,
    );

    expect(frameOf(el).label).toBe('Carregando a avaliação…');
    expect(el.querySelector('app-assessment-detail-skeleton')).not.toBeNull();

    read.release(undefined);
    await eventually(harness.fixture, () =>
      expect(el.querySelector('app-loading-frame')).toBeNull(),
    );
  });

  it('does not show an empty form while the assessment to edit is read, and shows the form after', async () => {
    const read = hold<undefined>();
    const { harness, el } = await waiting(
      '/treino/corpo/avaliacoes/qualquer/editar',
      () => void vi.spyOn(PhysicalAssessmentRepository.prototype, 'get').mockReturnValue(read.gate),
      read.release,
    );

    expect(frameOf(el).label).toBe('Carregando a avaliação…');
    expect(el.querySelector('app-assessment-form-skeleton')).not.toBeNull();
    expect(el.querySelector('form')).toBeNull();

    read.release(undefined);
    await eventually(harness.fixture, () => expect(el.querySelector('form')).not.toBeNull());
    expect(el.querySelector('app-loading-frame')).toBeNull();
  });

  it('holds the body page in a skeleton instead of "Sem Registros" until the records are read', async () => {
    const read = hold<[]>();
    const { harness, el } = await waiting(
      '/treino/corpo',
      () => void vi.spyOn(BodyRepository.prototype, 'entries').mockReturnValue(read.gate),
      read.release,
    );

    expect(frameOf(el).label).toBe('Carregando seus registros…');
    expect(el.querySelector('app-body-skeleton .sk-weight')).not.toBeNull();
    expect(el.textContent).not.toContain('Sem Registros');

    read.release([]);
    await eventually(harness.fixture, () =>
      expect(el.querySelector('app-body-skeleton')).toBeNull(),
    );
    expect(el.textContent).toContain('Registrar Peso');
  });

  it('holds the diary list in a skeleton, with the real day and form around it, until the day is read', async () => {
    const read = hold<[]>();
    const { harness, el } = await waiting(
      '/treino/alimentacao',
      () => void vi.spyOn(MealRepository.prototype, 'entriesOf').mockReturnValue(read.gate),
      read.release,
    );

    expect(frameOf(el).label).toBe('Carregando lançamentos…');
    expect(el.querySelector('#diary-day')).not.toBeNull();
    expect(el.textContent).not.toContain('Nada Registrado Neste Dia');

    read.release([]);
    await eventually(harness.fixture, () =>
      expect(el.querySelector('app-loading-frame')).toBeNull(),
    );
    expect(el.textContent).toContain('Nada Registrado Neste Dia');
  });
});

describe('the shapes of the waits that depend on a held read of their own', () => {
  @Component({
    imports: [
      AssessmentDetailSkeleton,
      AssessmentFormSkeleton,
      AssessmentsListSkeleton,
      BodyMapSkeleton,
      BodyMealsSkeleton,
      BodyPhotosSkeleton,
      BodySkeleton,
      ExerciseDetailSkeleton,
      FoodDiarySkeleton,
      FoodSearchSkeleton,
      ProgressChartSkeleton,
      ProgressSkeleton,
      RoutinesListSkeleton,
      TrainingFormSkeleton,
      TrainingRowsSkeleton,
    ],
    template: `
      <app-body-skeleton id="body-summary" [view]="'summary'" />
      <app-body-skeleton id="body-records" [view]="'records'" />
      <app-body-photos-skeleton />
      <app-body-meals-skeleton />
      <app-body-map-skeleton />
      <app-exercise-detail-skeleton />
      <app-food-diary-skeleton />
      <app-food-search-skeleton />
      <app-progress-skeleton />
      <app-progress-chart-skeleton />
      <app-routines-list-skeleton />
      <app-training-form-skeleton
        id="form"
        [label]="'Carregando o formulário…'"
        [fields]="3"
        [rows]="2"
      />
      <app-training-rows-skeleton [label]="'Carregando as linhas…'" [rows]="4" />
      <app-assessments-list-skeleton />
      <app-assessment-detail-skeleton />
      <app-assessment-form-skeleton />
    `,
  })
  class Gallery {}

  function render() {
    TestBed.configureTestingModule({});
    const fixture = TestBed.createComponent(Gallery);
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  }

  it('wraps every shape in the shared frame, announces one label each and hides the bones from screen readers', () => {
    const el = render();
    const frames = Array.from(el.querySelectorAll('app-loading-frame'));

    expect(frames).toHaveLength(16);
    for (const frame of frames) {
      expect(frame.getAttribute('aria-busy')).toBe('true');
      expect(frame.querySelector('[role="status"]')?.textContent?.trim()).not.toBe('');
      expect(frame.querySelector('.shape')?.getAttribute('aria-hidden')).toBe('true');
      expect(frame.querySelectorAll('.ui-skeleton').length).toBeGreaterThan(0);
    }
  });

  it('draws the edit forms without a back button of their own (the shell top bar owns it)', () => {
    const form = render().querySelector('#form') as HTMLElement;

    expect(form.querySelector('.sk-back')).toBeNull();
    expect(form.querySelectorAll('.sk-field')).toHaveLength(3);
    expect(form.querySelectorAll('.sk-card')).toHaveLength(2);
    expect(form.querySelectorAll('.sk-action')).toHaveLength(2);
  });

  it('gives each body tab the shape of its own content', () => {
    const el = render();

    expect(el.querySelectorAll('#body-summary .sk-signal')).toHaveLength(2);
    expect(el.querySelector('#body-summary .sk-plot')).not.toBeNull();
    expect(el.querySelectorAll('#body-records .sk-row')).toHaveLength(3);
    expect(el.querySelector('#body-records .sk-plot')).toBeNull();
  });
});
