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

  it('takeForClick hands over Ctrl, Shift and Alt in the fixed order and lets go of them', () => {
    armed.toggle('ALT');
    armed.toggle('CTRL');
    armed.toggle('SHIFT');
    expect(armed.takeForClick()).toEqual(['CTRL', 'SHIFT', 'ALT']);
    expect(armed.armed().size).toBe(0);
  });

  it('takeForClick leaves the Windows key armed: a click does not carry it', () => {
    armed.toggle('WIN');
    armed.toggle('CTRL');
    expect(armed.takeForClick()).toEqual(['CTRL']);
    expect([...armed.armed()]).toEqual(['WIN']);
    expect(armed.takeForClick()).toEqual([]);
    expect(armed.has('WIN')).toBe(true);
  });

  it('takeForClick with nothing armed changes nothing', () => {
    const before = armed.armed();
    expect(armed.takeForClick()).toEqual([]);
    expect(armed.armed()).toBe(before);
  });

  it('forgets what was armed when the account changes', () => {
    armed.toggle('CTRL');
    accountId.set('b');
    TestBed.tick();
    expect(armed.armed().size).toBe(0);
  });
});
