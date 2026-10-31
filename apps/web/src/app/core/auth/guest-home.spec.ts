import { UNKNOWN_GUEST_HOME, canUseModule, homeFor, modulePermission } from './guest-home';

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
  it('always returns Início without depending on a session or catalogue', () => {
    expect(homeFor()).toBe(UNKNOWN_GUEST_HOME);
  });
});
