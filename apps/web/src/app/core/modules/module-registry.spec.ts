import { TestBed } from '@angular/core/testing';
import { ModuleRegistry } from './module-registry';
import { SCOPED_MODULE_SLUGS } from './module-slugs';

describe('ModuleRegistry', () => {
  const registry = () => TestBed.inject(ModuleRegistry);

  it('lists TV as available and Treino as coming soon', () => {
    expect(registry().modules.map((m) => [m.id, m.status])).toEqual([
      ['tv', 'available'],
      ['training', 'soon'],
    ]);
  });

  it('has one scoped slug per module, matching the service worker list', () => {
    expect(registry().modules.map((m) => m.slug)).toEqual([...SCOPED_MODULE_SLUGS]);
  });

  it('finds modules by id and builds their path', () => {
    const tv = registry().find('tv')!;
    expect(registry().path(tv)).toBe('/tv');
    expect(registry().find('nada')).toBeUndefined();
  });
});
