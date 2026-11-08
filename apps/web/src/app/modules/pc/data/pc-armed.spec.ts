import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { SessionState } from '../../../core/session/session-state';
import { PcArmed } from './pc-armed';

describe('PcArmed', () => {
  const accountId = signal<string | null>('a');
  let armed: PcArmed;

  beforeEach(() => {
    accountId.set('a');
    TestBed.configureTestingModule({
      providers: [{ provide: SessionState, useValue: { accountId } }],
    });
    armed = TestBed.inject(PcArmed);
    TestBed.tick();
  });

  it('arms and disarms with a toggle', () => {
    armed.toggle('CTRL');
    expect(armed.has('CTRL')).toBe(true);
    armed.toggle('CTRL');
    expect(armed.has('CTRL')).toBe(false);
  });

  it('take hands over what is armed plus the base, in the fixed order, and lets go of all', () => {
    armed.toggle('ALT');
    armed.toggle('CTRL');
    expect(armed.take(['SHIFT'])).toEqual(['CTRL', 'SHIFT', 'ALT']);
    expect(armed.armed().size).toBe(0);
  });

  it('take without anything armed returns the base untouched', () => {
    const base = ['WIN'] as const;
    expect(armed.take(base)).toBe(base);
  });

  it('forgets what was armed when the account changes', () => {
    armed.toggle('CTRL');
    accountId.set('b');
    TestBed.tick();
    expect(armed.armed().size).toBe(0);
  });
});
