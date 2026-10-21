import {
  NO_ACCESS_PATH,
  UNKNOWN_GUEST_HOME,
  canUseModule,
  homeFor,
  modulePermission,
} from './guest-home';

// A ordem é a do registro de módulos: a TV antes do Treino; um módulo só planejado não tem caminho (sem `slug`).
const MODULES = [
  { id: 'tv', slug: 'tv' },
  { id: 'training', slug: 'treino' },
  { id: 'health' },
] as const;

describe('modulePermission', () => {
  it('is the permission of the catalogue of the API', () => {
    expect(modulePermission('tv')).toBe('module:tv');
    expect(modulePermission('training')).toBe('module:training');
  });
});

describe('canUseModule', () => {
  it('lets the owner into everything, whatever the list says', () => {
    expect(canUseModule('owner', [], 'training')).toBe(true);
    expect(canUseModule('owner', null, 'tv')).toBe(true);
  });

  it('lets in whoever has no role yet (the session is still to be confirmed)', () => {
    expect(canUseModule(null, null, 'training')).toBe(true);
  });

  it('lets the guest into the modules of the list only', () => {
    expect(canUseModule('guest', ['module:training'], 'training')).toBe(true);
    expect(canUseModule('guest', ['module:training'], 'tv')).toBe(false);
    expect(canUseModule('guest', ['module:tv', 'tv:power'], 'training')).toBe(false);
    expect(canUseModule('guest', [], 'tv')).toBe(false);
  });

  it('does not lock the guest out when the list is not known (offline, an answer without a list)', () => {
    expect(canUseModule('guest', null, 'training')).toBe(true);
    expect(canUseModule('guest', null, 'tv')).toBe(true);
  });
});

describe('homeFor', () => {
  it('is the Início for the owner (and for a role not known yet)', () => {
    expect(homeFor('owner', ['module:tv'], MODULES)).toBe('/');
    expect(homeFor(null, null, MODULES)).toBe('/');
  });

  it.each([
    ['only the TV', ['module:tv', 'tv:control'], '/tv'],
    ['only the Treino', ['module:training'], '/treino'],
    ['both (the TV comes first in the registry)', ['module:training', 'module:tv'], '/tv'],
  ])('takes a guest with %s to the first module he can use', (_name, permissions, home) => {
    expect(homeFor('guest', permissions, MODULES)).toBe(home);
  });

  it('takes a guest with no module to the "no access" screen, never to a module', () => {
    expect(homeFor('guest', [], MODULES)).toBe(NO_ACCESS_PATH);
    expect(homeFor('guest', ['tv:control'], MODULES)).toBe(NO_ACCESS_PATH);
  });

  it('ignores a module that is only planned (no screen to open)', () => {
    expect(homeFor('guest', ['module:health'], MODULES)).toBe(NO_ACCESS_PATH);
  });

  it('keeps the TV when the list is not known', () => {
    expect(homeFor('guest', null, MODULES)).toBe(UNKNOWN_GUEST_HOME);
  });

  it('never points to a module the same account cannot use', () => {
    for (const permissions of [
      [],
      ['module:tv'],
      ['module:training'],
      ['module:tv', 'module:training'],
    ]) {
      const home = homeFor('guest', permissions, MODULES);
      const module = MODULES.find((item) => 'slug' in item && `/${item.slug}` === home);
      if (module) expect(canUseModule('guest', permissions, module.id)).toBe(true);
      else expect(home).toBe(NO_ACCESS_PATH);
    }
  });
});
