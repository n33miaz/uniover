import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { collectShellData } from '../../core/layout/route-data';
import { TrainingSync } from './data/sync/training-sync';
import { setupScreen } from './shell/screen-test-kit';
import { TRAINING_ROUTES } from './training.routes';

describe('training routes', () => {
  const root = TRAINING_ROUTES[0];
  const children = root.children ?? [];

  it('has three tabs with Início in the center and Corpo under Progresso', () => {
    const tabs = (root.data as { tabs: { link: string; label: string }[] }).tabs;
    expect(tabs.map((tab) => [tab.label, tab.link])).toEqual([
      ['Exercício', '/treino/exercicios'],
      ['Início', '/treino'],
      ['Progresso', '/treino/progresso'],
    ]);
  });

  it('keeps routine screens under Exercício and Corpo under Progresso', () => {
    const tabs = (root.data as { tabs: { link: string; nested?: boolean; also?: string[] }[] })
      .tabs;
    const exercises = tabs.find((tab) => tab.link === '/treino/exercicios')!;
    expect(exercises.nested).toBe(true);
    expect(exercises.also).toEqual(['/treino/rotinas']);
    expect(tabs.find((tab) => tab.link === '/treino/progresso')?.also).toEqual([
      '/treino/corpo',
      '/treino/alimentacao',
    ]);
  });

  it('declares every screen of the module, fixed paths before the ones with an id', () => {
    const paths = children.map((child) => child.path);
    expect(paths).toEqual([
      '',
      'exercicios',
      'exercicios/novo',
      'exercicios/mapa',
      'exercicios/:id/editar',
      'exercicios/:id',
      'rotinas',
      'rotinas/nova',
      'rotinas/:id',
      'progresso',
      'alimentacao',
      'corpo',
      'corpo/avaliacoes/importar',
      'corpo/avaliacoes/nova',
      'corpo/avaliacoes/:id/editar',
      'corpo/avaliacoes/:id',
      'corpo/avaliacoes',
    ]);
    expect(paths.indexOf('exercicios/novo')).toBeLessThan(paths.indexOf('exercicios/:id'));
    expect(paths.indexOf('exercicios/mapa')).toBeLessThan(paths.indexOf('exercicios/:id'));
    expect(paths.indexOf('rotinas/nova')).toBeLessThan(paths.indexOf('rotinas/:id'));
    expect(paths.indexOf('corpo/avaliacoes/nova')).toBeLessThan(
      paths.indexOf('corpo/avaliacoes/:id'),
    );
    expect(paths.indexOf('corpo/avaliacoes/importar')).toBeLessThan(
      paths.indexOf('corpo/avaliacoes/:id'),
    );
  });

  it('loads every page lazily', () => {
    for (const child of children) {
      expect(child.loadComponent, child.path).toBeTypeOf('function');
      expect(child.component, child.path).toBeUndefined();
    }
  });

  describe('in the router', () => {
    async function navigate(url: string) {
      const kit = await setupScreen([
        { path: 'treino', data: { title: 'Treino' }, children: TRAINING_ROUTES },
      ]);
      const harness = await kit.harness();
      await harness.navigateByUrl(url);
      const router = TestBed.inject(Router);
      return { harness, data: collectShellData(router.routerState.snapshot.root) };
    }

    it.each([
      '/treino',
      '/treino/exercicios',
      '/treino/exercicios/abc',
      '/treino/rotinas',
      '/treino/progresso',
      '/treino/corpo',
      '/treino/alimentacao',
      '/treino/corpo/avaliacoes',
      '/treino/corpo/avaliacoes/exemplo',
    ])('%s shows the tab bar with the three tabs', async (url) => {
      const { data } = await navigate(url);
      expect(data.title).toBe('Treino');
      expect(data.tabs?.map((tab) => tab.label)).toEqual(['Exercício', 'Início', 'Progresso']);
    });

    it.each([
      '/treino/exercicios/novo',
      '/treino/exercicios/abc/editar',
      '/treino/rotinas/nova',
      '/treino/rotinas/abc',
      '/treino/corpo/avaliacoes/nova',
      '/treino/corpo/avaliacoes/importar',
      '/treino/corpo/avaliacoes/exemplo/editar',
    ])('%s is an editing screen: no tab bar', async (url) => {
      const { data } = await navigate(url);
      expect(data.tabs).toEqual([]);
    });

    it('opens the module shell around the page, and turns the puller on once', async () => {
      const kit = await setupScreen([
        { path: 'treino', data: { title: 'Treino' }, children: TRAINING_ROUTES },
      ]);
      const start = vi.spyOn(TrainingSync.prototype, 'start');
      const harness = await kit.harness();
      await harness.navigateByUrl('/treino');
      const el = harness.routeNativeElement as HTMLElement;
      // A rota abre o escopo da conta, e a casca do módulo fica dentro dele.
      expect(el.matches('app-training-account-scope')).toBe(true);
      expect(el.querySelector('app-training-page')).not.toBeNull();
      expect(el.querySelector('.training-header h1')?.textContent).toBe('UniOver Treino');
      expect(el.querySelector('.training-header .status')).not.toBeNull();
      expect(el.querySelector('app-training-today-page')).not.toBeNull();
      expect(start).toHaveBeenCalledTimes(1);
      start.mockRestore();
    });

    it('sends the map path to its own page, not to the sheet of an exercise', async () => {
      const { harness } = await navigate('/treino/exercicios/mapa');
      const el = harness.routeNativeElement as HTMLElement;
      expect(el.querySelector('app-training-body-map-page')).not.toBeNull();
      expect(el.querySelector('app-exercise-detail-page')).toBeNull();
    });

    it('sends the new-exercise path to the form, not to the sheet of an exercise', async () => {
      const { harness } = await navigate('/treino/exercicios/novo');
      const el = harness.routeNativeElement as HTMLElement;
      expect(el.querySelector('app-exercise-form-page')).not.toBeNull();
      expect(el.querySelector('app-exercise-detail-page')).toBeNull();
    });

    it('links the Body screen to the local physical assessment history', async () => {
      const { harness } = await navigate('/treino/corpo');
      const link = harness.routeNativeElement!.querySelector<HTMLAnchorElement>(
        'a[routerlink="/treino/corpo/avaliacoes"]',
      );
      expect(link?.textContent).toContain('Avaliações Físicas');
      expect(link?.textContent).toContain('Ver Histórico');
      expect(link?.getAttribute('href')).toBe('/treino/corpo/avaliacoes');
      link!.click();
      await harness.fixture.whenStable();
      expect(
        harness.routeNativeElement?.querySelector('app-physical-assessments-page'),
      ).not.toBeNull();
    });
  });
});
