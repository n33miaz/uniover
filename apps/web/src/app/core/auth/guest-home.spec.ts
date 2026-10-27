import { UNKNOWN_GUEST_HOME, canUseModule, homeFor, modulePermission } from './guest-home';

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
    ['only the TV', ['module:tv', 'tv:control']],
    ['only the Treino', ['module:training']],
    ['both modules', ['module:training', 'module:tv']],
    ['no modules', []],
  ])('takes a guest with %s to Início', (_name, permissions) => {
    expect(homeFor('guest', permissions, MODULES)).toBe('/');
  });

  it('keeps Início when the list is not known', () => {
    expect(homeFor('guest', null, MODULES)).toBe(UNKNOWN_GUEST_HOME);
  });
});
