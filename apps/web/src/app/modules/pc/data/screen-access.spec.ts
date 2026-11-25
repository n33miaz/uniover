import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { PcAvailability } from '../../../core/modules/pc-availability';
import { SessionState } from '../../../core/session/session-state';
import { PcScreenAccess } from './screen-access';

function setup(opts: {
  capabilities?: string[];
  role?: 'owner' | 'guest';
  permissions?: string[];
}) {
  const user = signal({ role: opts.role ?? 'owner', permissions: opts.permissions });
  TestBed.configureTestingModule({
    providers: [
      { provide: PcAvailability, useValue: { capabilities: () => opts.capabilities ?? [] } },
      {
        provide: SessionState,
        useValue: { isAuthenticated: () => true, role: () => user().role, user },
      },
    ],
  });
  return TestBed.inject(PcScreenAccess);
}

describe('PcScreenAccess', () => {
  it('is hidden while the PC does not declare the screen capability (flag off)', () => {
    expect(setup({ capabilities: ['pc.key.v2'] }).allowed()).toBe(false);
  });

  it('is allowed for the owner when the PC declares the capability', () => {
    expect(setup({ capabilities: ['pc.screen.v1'] }).allowed()).toBe(true);
  });

  it('is hidden for a guest, even with the capability and the permission', () => {
    expect(
      setup({
        capabilities: ['pc.screen.v1'],
        role: 'guest',
        permissions: ['pc:screen'],
      }).allowed(),
    ).toBe(false);
  });

  it('only offers the touch when the PC also declares pc.abs.v1', () => {
    expect(setup({ capabilities: ['pc.screen.v1'] }).touch()).toBe(false);
    TestBed.resetTestingModule();
    expect(setup({ capabilities: ['pc.screen.v1', 'pc.abs.v1'] }).touch()).toBe(true);
  });

  it('never offers the touch without the screen itself', () => {
    expect(setup({ capabilities: ['pc.abs.v1'] }).touch()).toBe(false);
  });
});
