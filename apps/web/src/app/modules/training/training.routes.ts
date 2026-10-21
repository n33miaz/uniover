import { Routes } from '@angular/router';
import type { TabItem } from '../../shared/ui/tab-bar/tab-bar';
import { provideTrainingData } from './data/training-data.providers';
import { TrainingPage } from './shell/training.page';

// As abas do módulo ficam aqui; a barra de baixo as lê pelo `data.tabs` da rota (a mais específica vence).
const TABS: readonly TabItem[] = [
  { link: '/treino', label: $localize`:@@training.tab.today:Hoje` },
  { link: '/treino/exercicios', label: $localize`:@@training.tab.exercises:Exercícios` },
  { link: '/treino/progresso', label: $localize`:@@training.tab.progress:Progresso` },
  { link: '/treino/corpo', label: $localize`:@@training.tab.body:Corpo` },
];

// Formulário e editor são telas de edição: sem a barra de abas. Ela cobre a altura do teclado, e uma aba tocada no meio
// da edição sairia sem passar pela confirmação de "descartar alterações".
const NO_TABS = { tabs: [] as readonly TabItem[] };

/**
 * Rotas do módulo. A casca (`TrainingPage`) fica em volta de todas e traz os dados do módulo; as rotas fixas vêm
 * antes das que têm `:id`. Cada aba é uma página preguiçosa.
 */
export const TRAINING_ROUTES: Routes = [
  {
    path: '',
    component: TrainingPage,
    providers: [provideTrainingData()],
    data: { tabs: TABS },
    children: [
      {
        path: '',
        pathMatch: 'full',
        loadComponent: () => import('./today/today.page').then((m) => m.TodayPage),
      },
      {
        path: 'exercicios',
        pathMatch: 'full',
        loadComponent: () =>
          import('./exercises/library/library.page').then((m) => m.ExerciseLibraryPage),
      },
      {
        path: 'exercicios/novo',
        data: NO_TABS,
        loadComponent: () =>
          import('./exercises/form/exercise-form.page').then((m) => m.ExerciseFormPage),
      },
      {
        path: 'exercicios/mapa',
        loadComponent: () =>
          import('./exercises/body-map/body-map.page').then((m) => m.BodyMapPage),
      },
      {
        path: 'exercicios/:id/editar',
        data: NO_TABS,
        loadComponent: () =>
          import('./exercises/form/exercise-form.page').then((m) => m.ExerciseFormPage),
      },
      {
        path: 'exercicios/:id',
        loadComponent: () =>
          import('./exercises/detail/detail.page').then((m) => m.ExerciseDetailPage),
      },
      {
        path: 'rotinas',
        pathMatch: 'full',
        loadComponent: () =>
          import('./routines/routines-list.page').then((m) => m.RoutinesListPage),
      },
      {
        path: 'rotinas/nova',
        data: NO_TABS,
        loadComponent: () =>
          import('./routines/editor/routine-editor.page').then((m) => m.RoutineEditorPage),
      },
      {
        path: 'rotinas/:id',
        data: NO_TABS,
        loadComponent: () =>
          import('./routines/editor/routine-editor.page').then((m) => m.RoutineEditorPage),
      },
      {
        path: 'progresso',
        loadComponent: () => import('./progress/progress.page').then((m) => m.ProgressPage),
      },
      {
        path: 'corpo',
        loadComponent: () => import('./body/body.page').then((m) => m.BodyPage),
      },
    ],
  },
];
