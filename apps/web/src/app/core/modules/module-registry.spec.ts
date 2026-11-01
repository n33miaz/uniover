import { TestBed } from '@angular/core/testing';
import { ModuleRegistry } from './module-registry';
import { SCOPED_MODULE_SLUGS } from './module-slugs';

describe('ModuleRegistry', () => {
  const registry = () => TestBed.inject(ModuleRegistry);

  it('lists TV, Treino and TV Livre first, all with a screen, then the planned modules in the order of the plan', () => {
    expect(registry().modules.map((m) => [m.id, m.status])).toEqual([
      ['tv', 'available'],
      ['training', 'available'],
      ['tv-livre', 'available'],
      ['health', 'soon'],
      ['monitor', 'soon'],
      ['network', 'soon'],
      ['backup', 'soon'],
      ['notifications', 'soon'],
      ['pc', 'soon'],
    ]);
  });

  it('titles the planned modules in pt-BR', () => {
    expect(
      registry()
        .modules.slice(3)
        .map((m) => m.title),
    ).toEqual([
      'Saúde e Eventos',
      'Monitor dos Serviços',
      'Rede da Casa',
      'Backup de Fotos',
      'Avisos',
      'Controle do PC',
    ]);
  });

  it('only modules with a screen have a slug, and the slugs match the service worker list', () => {
    const withSlug = registry().modules.flatMap((m) => (m.slug ? [m.slug] : []));
    expect(withSlug).toEqual([...SCOPED_MODULE_SLUGS]);
    // Um módulo planejado não ganha rota, manifest nem escopo: sem slug, sem caminho e sem ação.
    for (const planned of registry().modules.slice(3)) {
      expect(planned.slug, planned.id).toBeUndefined();
      expect(planned.route, planned.id).toBeUndefined();
      expect(planned.actionLabel, planned.id).toBeUndefined();
    }
  });

  it('puts the TV Livre inside the TV: its own path, but no slug of its own (no manifest, no scope)', () => {
    const livre = registry().find('tv-livre')!;
    expect(livre.slug).toBeUndefined();
    expect(livre.route).toBe('/tv/livre');
    expect(livre.title).toBe('TV Livre');
    expect(livre.actionLabel).toBeTruthy();
    expect(SCOPED_MODULE_SLUGS).not.toContain('tv-livre');
  });

  it('describes and draws an icon for every module, and every id is unique', () => {
    const modules = registry().modules;
    for (const module of modules) {
      expect(module.description.trim().length, module.id).toBeGreaterThan(0);
    }
    expect(new Set(modules.map((m) => m.id)).size).toBe(modules.length);
    expect(new Set(modules.map((m) => m.icon)).size).toBe(modules.length);
  });

  it('finds modules by id and builds their path (none for a planned one)', () => {
    const tv = registry().find('tv')!;
    expect(registry().path(tv)).toBe('/tv');
    expect(registry().path(registry().find('training')!)).toBe('/treino');
    expect(registry().path(registry().find('tv-livre')!)).toBe('/tv/livre');
    expect(registry().path(registry().find('health')!)).toBeNull();
    expect(registry().find('nada')).toBeUndefined();
  });
});
