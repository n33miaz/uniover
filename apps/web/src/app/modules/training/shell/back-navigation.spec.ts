import { Location } from '@angular/common';
import { provideLocationMocks } from '@angular/common/testing';
import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter, type Route } from '@angular/router';
import { TRAINING_ROUTES } from '../training.routes';
import {
  BackNavigation,
  TRAINING_LOGICAL_PARENTS,
  TRAINING_ROUTE_PARENTS,
  trainingParent,
} from './back-navigation';

@Component({ template: '' })
class Blank {}

function setup() {
  TestBed.configureTestingModule({
    providers: [provideRouter([{ path: '**', component: Blank }]), provideLocationMocks()],
  });
  const router = TestBed.inject(Router);
  // Sem o bootstrap do app, ninguém liga o roteador ao botão voltar do navegador (o histórico simulado).
  router.setUpLocationChangeListener();
  const location = TestBed.inject(Location);
  // O serviço acompanha as navegações desde que existe: criado antes da primeira, como a casca do módulo faz.
  const back = TestBed.inject(BackNavigation);
  const navigate = vi.spyOn(router, 'navigateByUrl');
  const historyBack = vi.spyOn(location, 'back');
  return { router, location, back, navigate, historyBack };
}

describe('BackNavigation', () => {
  it('goes back one history entry when the previous entry is the parent, keeping its filters', async () => {
    const { router, back, navigate, historyBack } = setup();
    await router.navigateByUrl('/treino/exercicios?q=halteres');
    await router.navigateByUrl('/treino/exercicios/abc');
    navigate.mockClear();

    back.back('/treino/exercicios');
    await vi.waitFor(() => expect(router.url).toBe('/treino/exercicios?q=halteres'));

    expect(historyBack).toHaveBeenCalledOnce();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('goes to the parent replacing the entry when the screen was opened straight by its address', async () => {
    const { router, back, navigate, historyBack } = setup();
    await router.navigateByUrl('/treino/exercicios/abc');

    back.back('/treino/exercicios');
    await vi.waitFor(() => expect(router.url).toBe('/treino/exercicios'));

    expect(historyBack).not.toHaveBeenCalled();
    expect(navigate).toHaveBeenLastCalledWith('/treino/exercicios', { replaceUrl: true });
  });

  it('goes to the parent when the previous entry belongs to another module', async () => {
    const { router, back, navigate, historyBack } = setup();
    await router.navigateByUrl('/tv');
    await router.navigateByUrl('/treino/exercicios/abc');

    back.back('/treino/exercicios');
    await vi.waitFor(() => expect(router.url).toBe('/treino/exercicios'));

    expect(historyBack).not.toHaveBeenCalled();
    expect(navigate).toHaveBeenLastCalledWith('/treino/exercicios', { replaceUrl: true });
  });

  it('goes to the parent when the previous entry is a sibling, not the parent', async () => {
    const { router, back, navigate, historyBack } = setup();
    await router.navigateByUrl('/treino/rotinas');
    await router.navigateByUrl('/treino/exercicios/abc');

    back.back('/treino/exercicios');
    await vi.waitFor(() => expect(router.url).toBe('/treino/exercicios'));

    expect(historyBack).not.toHaveBeenCalled();
    expect(navigate).toHaveBeenLastCalledWith('/treino/exercicios', { replaceUrl: true });
  });

  it('also goes back one entry when the screen has another legitimate origin', async () => {
    const { router, back, navigate, historyBack } = setup();
    await router.navigateByUrl('/treino/rotinas');
    await router.navigateByUrl('/treino/glossario');

    back.back('/treino');
    await vi.waitFor(() => expect(router.url).toBe('/treino/rotinas'));
    expect(historyBack).toHaveBeenCalledOnce();

    // De uma tela que não é origem do glossário, o destino é o pai.
    await router.navigateByUrl('/treino/exercicios');
    await router.navigateByUrl('/treino/glossario');
    navigate.mockClear();
    back.back('/treino');
    await vi.waitFor(() => expect(router.url).toBe('/treino'));
    expect(navigate).toHaveBeenLastCalledWith('/treino', { replaceUrl: true });
  });

  it('requires the query parameters the parent asks for, and ignores the ones it does not', async () => {
    const { router, back, historyBack } = setup();
    await router.navigateByUrl('/treino/exercicios?q=x');
    await router.navigateByUrl('/treino/exercicios/abc');

    back.back('/treino/exercicios?q=x');
    await vi.waitFor(() => expect(router.url).toBe('/treino/exercicios?q=x'));
    expect(historyBack).toHaveBeenCalledOnce();

    await router.navigateByUrl('/treino/exercicios/abc');
    back.back('/treino/exercicios?q=outro');
    await vi.waitFor(() => expect(router.url).toBe('/treino/exercicios?q=outro'));
    expect(historyBack).toHaveBeenCalledOnce();
  });

  it('keeps the parent as the previous entry when a screen replaces itself', async () => {
    const { router, back, historyBack } = setup();
    await router.navigateByUrl('/treino/exercicios?q=x');
    await router.navigateByUrl('/treino/exercicios/abc/editar');
    // Salvar troca o formulário pela ficha: a entrada anterior continua sendo a lista.
    await router.navigateByUrl('/treino/exercicios/abc', { replaceUrl: true });

    back.back('/treino/exercicios');
    await vi.waitFor(() => expect(router.url).toBe('/treino/exercicios?q=x'));
    expect(historyBack).toHaveBeenCalledOnce();
  });

  it('keeps tracking the entries after the browser moved the history', async () => {
    const { router, back, historyBack } = setup();
    await router.navigateByUrl('/treino/exercicios?q=x');
    await router.navigateByUrl('/treino/exercicios/um');
    back.back('/treino/exercicios');
    await vi.waitFor(() => expect(router.url).toBe('/treino/exercicios?q=x'));

    // Abre outra ficha sobre a lista restaurada e volta de novo: a lista ainda é a entrada anterior.
    await router.navigateByUrl('/treino/exercicios/dois');
    back.back('/treino/exercicios');
    await vi.waitFor(() => expect(router.url).toBe('/treino/exercicios?q=x'));
    expect(historyBack).toHaveBeenCalledTimes(2);
  });

  it('starts from the screen it was created on, when the first navigation already happened', async () => {
    TestBed.configureTestingModule({
      providers: [provideRouter([{ path: '**', component: Blank }]), provideLocationMocks()],
    });
    const router = TestBed.inject(Router);
    router.setUpLocationChangeListener();
    await router.navigateByUrl('/treino/exercicios');
    // A casca do módulo (que cria o serviço) só aparece depois que o banco da conta abre.
    const back = TestBed.inject(BackNavigation);
    const historyBack = vi.spyOn(TestBed.inject(Location), 'back');
    await router.navigateByUrl('/treino/exercicios/abc');

    back.back('/treino/exercicios');
    await vi.waitFor(() => expect(router.url).toBe('/treino/exercicios'));
    expect(historyBack).toHaveBeenCalledOnce();
  });

  it('still recognises the list after it rewrote its own filters in the address', async () => {
    const { router, location, back, historyBack } = setup();
    await router.navigateByUrl('/treino/exercicios');
    // Como a lista faz ao filtrar: troca o endereço sem passar pelo roteador, mantendo o estado do histórico.
    location.replaceState('/treino/exercicios', 'q=halteres', location.getState());
    await router.navigateByUrl('/treino/exercicios/um');
    back.back('/treino/exercicios');
    // O histórico simulado devolve só o caminho; o navegador de verdade devolve o endereço com o filtro.
    await vi.waitFor(() => expect(router.url.split('?')[0]).toBe('/treino/exercicios'));

    await router.navigateByUrl('/treino/exercicios/dois');
    back.back('/treino/exercicios');
    await vi.waitFor(() => expect(historyBack).toHaveBeenCalledTimes(2));
  });

  it('does not trust entries the service never saw, as after a reload', async () => {
    const { router, location, navigate, historyBack } = setup();
    await router.navigateByUrl('/treino/exercicios?q=x');
    await router.navigateByUrl('/treino/exercicios/abc');
    // Recarga: um serviço novo, sem memória, sobre o mesmo histórico.
    const fresh = TestBed.runInInjectionContext(() => new BackNavigation());
    expect(location.path()).toBe('/treino/exercicios/abc');

    fresh.back('/treino/exercicios');
    await vi.waitFor(() => expect(router.url).toBe('/treino/exercicios'));
    expect(historyBack).not.toHaveBeenCalled();
    expect(navigate).toHaveBeenLastCalledWith('/treino/exercicios', { replaceUrl: true });
  });
});

describe('logical parents of the training routes', () => {
  const routes = (TRAINING_ROUTES[0].children ?? []) as Route[];
  const declared = routes.map((route) => route.path ?? '');
  const depth = (path: string) => path.split('/').filter(Boolean).length;
  const asRoutePath = (url: string) => url.replace(/^\/treino\/?/, '');

  /** Troca cada `:id` do padrão por um valor, como o endereço de verdade. */
  const concrete = (pattern: string) => pattern.replace(/:id/g, 'x1');
  /** Acha a rota declarada que atende um endereço (as fixas vêm antes das que têm `:id`, como no roteador). */
  const routeOf = (url: string): string | undefined => {
    const given = asRoutePath(url).split('/').filter(Boolean);
    return declared.find((path) => {
      const parts = path.split('/').filter(Boolean);
      return (
        parts.length === given.length &&
        parts.every((part, index) => part.startsWith(':') || part === given[index])
      );
    });
  };

  it('has a parent (or an explicit "none") for every declared route and nothing else', () => {
    expect([...declared].sort()).toEqual(Object.keys(TRAINING_ROUTE_PARENTS).sort());
  });

  it('points every inner screen to a declared route that is never deeper than it', () => {
    for (const [path, parent] of Object.entries(TRAINING_ROUTE_PARENTS)) {
      if (parent === null) continue;
      const target = routeOf(concrete(parent));
      expect(target, `${path} -> ${parent}`).toBeDefined();
      expect(target).not.toBe(path);
      expect(depth(target ?? '') <= depth(path), `${path} -> ${parent}`).toBe(true);
    }
  });

  it('reaches a tab-level screen by following the parents, with no cycle', () => {
    for (const start of Object.keys(TRAINING_ROUTE_PARENTS)) {
      let cursor: string | undefined = start;
      let hops = 0;
      while (cursor !== undefined && TRAINING_ROUTE_PARENTS[cursor] !== null && hops++ < 10) {
        cursor = routeOf(concrete(TRAINING_ROUTE_PARENTS[cursor] as string));
      }
      expect(cursor !== undefined && TRAINING_ROUTE_PARENTS[cursor] === null, start).toBe(true);
    }
  });

  it('keeps the constants the pages use equal to the table', () => {
    expect(TRAINING_LOGICAL_PARENTS).toEqual({
      workoutDay: '/treino',
      workoutExercise: '/treino/sessao',
      foodDiary: '/treino/corpo',
      assessments: '/treino/corpo',
      assessment: '/treino/corpo/avaliacoes',
    });
  });

  it('finds the logical parent from a concrete address for the shared top back button', () => {
    expect(trainingParent('/treino')).toBeNull();
    expect(trainingParent('/treino/exercicios/abc?from=search')).toBe('/treino/exercicios');
    expect(trainingParent('/treino/exercicios/abc/editar')).toBe('/treino/exercicios/abc');
    expect(trainingParent('/treino/corpo/avaliacoes/nova')).toBe('/treino/corpo/avaliacoes');
  });
});
