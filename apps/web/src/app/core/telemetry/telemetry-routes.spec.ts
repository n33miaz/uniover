import type { Route, Routes } from '@angular/router';
import contract from '../../../../../../contracts/http/openapi.json';
import { routes } from '../../app.routes';
import { API_ROUTES, PAGE_ROUTES } from './telemetry-routes';
import { UNKNOWN_SEGMENT, normalizeApiPath, normalizeRoute } from './telemetry-sanitize';

/** Todos os caminhos reais do app, resolvendo as rotas preguiçosas (`loadChildren`), com `:param` como vêm nas definições. */
async function collect(list: Routes, prefix: string, out: Set<string>): Promise<void> {
  for (const route of list) {
    if (route.redirectTo !== undefined && route.path === '**') continue;
    const here = joinPath(prefix, route.path);
    if (route.path !== '**') out.add(here);
    if (route.children) await collect(route.children, here, out);
    if (route.loadChildren) {
      const loaded = (await route.loadChildren()) as Route[] | { default?: Route[] };
      await collect(Array.isArray(loaded) ? loaded : (loaded.default ?? []), here, out);
    }
  }
}

function joinPath(prefix: string, path: string | undefined): string {
  const segments = [...prefix.split('/'), ...(path ?? '').split('/')].filter((s) => s.length > 0);
  return `/${segments.join('/')}`;
}

describe('telemetry route models', () => {
  it('recognizes every real route of the app whole: none of them falls into the unknown marker', async () => {
    const real = new Set<string>();
    await collect(routes, '', real);
    expect(real.size).toBeGreaterThan(30);
    const unknown = [...real].filter((path) => normalizeRoute(path).includes(UNKNOWN_SEGMENT));
    expect(unknown).toEqual([]);
  });

  it('every real route, written with a parameter value, maps to its own model', async () => {
    const real = new Set<string>();
    await collect(routes, '', real);
    for (const path of real) {
      const filled = path.replace(/:[A-Za-z]+/g, 'valor-qualquer');
      expect(normalizeRoute(filled)).toBe(path.replace(/:[A-Za-z]+/g, ':id'));
    }
  });

  it('keeps no model with a parameter name other than :id, and no duplicates', () => {
    for (const list of [PAGE_ROUTES, API_ROUTES]) {
      expect(new Set(list).size).toBe(list.length);
      for (const model of list) expect(model.replace(/:id/g, '')).not.toContain(':');
    }
  });

  it('the API models are the paths of the published contract', () => {
    const published = Object.keys((contract as { paths: Record<string, unknown> }).paths)
      .filter((path) => path.startsWith('/api/'))
      .map((path) => path.replace(/{[^}]+}/g, ':id'));
    expect(published.length).toBeGreaterThan(100);
    for (const path of published) {
      const filled = path.replace(/:id/g, 'valor');
      expect(normalizeApiPath(filled)).toBe(path);
    }
  });
});
