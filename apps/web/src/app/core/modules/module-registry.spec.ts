import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { ModuleRegistry } from './module-registry';
import { PcAvailability } from './pc-availability';
import { SCOPED_MODULE_SLUGS } from './module-slugs';

describe('ModuleRegistry', () => {
  const registry = () => TestBed.inject(ModuleRegistry);

  it('lists TV and Treino first, both with a screen, then the planned modules in the order of the plan', () => {
    expect(registry().modules.map((m) => [m.id, m.status])).toEqual([
      ['tv', 'available'],
      ['training', 'available'],
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
        .modules.slice(2)
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
    // Um módulo planejado não ganha rota, manifest nem escopo: sem slug e sem ação. O Controle do PC tem tela dentro do
    // app principal (rota, sem manifest próprio) e só deixa de ser "Em Breve" quando a casa tem um PC com o controle ligado.
    for (const planned of registry().modules.slice(2)) {
      expect(planned.slug, planned.id).toBeUndefined();
      if (planned.id === 'pc') continue;
      expect(planned.route, planned.id).toBeUndefined();
      expect(planned.actionLabel, planned.id).toBeUndefined();
    }
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
    expect(registry().path(registry().find('health')!)).toBeNull();
    expect(registry().find('nada')).toBeUndefined();
  });

  describe('the PC control card', () => {
    const available = signal(false);

    beforeEach(() => {
      available.set(false);
      TestBed.configureTestingModule({
        providers: [{ provide: PcAvailability, useValue: { available } }],
      });
    });

    it('is still "Em Breve", with no path, until the house has a PC with the control on', () => {
      const pc = registry().find('pc')!;
      expect(registry().statusOf(pc)).toBe('soon');
      expect(registry().path(pc)).toBeNull();
    });

    it('opens like a module as soon as a PC with the control is known, inside the main app', () => {
      available.set(true);
      const pc = registry().find('pc')!;
      expect(registry().statusOf(pc)).toBe('available');
      expect(registry().path(pc)).toBe('/pc');
    });

    it('never changes the other planned modules', () => {
      available.set(true);
      for (const id of ['health', 'monitor', 'network', 'backup', 'notifications']) {
        const planned = registry().find(id)!;
        expect(registry().statusOf(planned), id).toBe('soon');
        expect(registry().path(planned), id).toBeNull();
      }
    });
  });
});
