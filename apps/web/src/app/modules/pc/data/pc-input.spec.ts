import { TestBed } from '@angular/core/testing';
import { SessionState } from '../../../core/session/session-state';
import { FakePcStore, createFakePcStore } from '../pc-test-kit';
import { PcArmed } from './pc-armed';
import { PcInput } from './pc-input';
import { PcStore } from './pc-store';

describe('PcInput', () => {
  let store: FakePcStore;
  let input: PcInput;

  const flush = async () => {
    for (let round = 0; round < 8; round++) await Promise.resolve();
  };
  const signIn = (id: string) =>
    TestBed.inject(SessionState).setUser({
      id,
      email: `${id}@exemplo.com`,
      displayName: id,
      role: 'owner',
    });

  beforeEach(() => {
    store = createFakePcStore();
    TestBed.configureTestingModule({ providers: [{ provide: PcStore, useValue: store }] });
    signIn('ana');
    input = TestBed.inject(PcInput);
    TestBed.tick();
  });

  it('keys and typed text from any screen go through one line, in the order they were asked', async () => {
    let answer!: () => void;
    store.sendText.mockImplementationOnce(
      () => new Promise((resolve) => (answer = () => resolve(null))),
    );
    input.edit({ erase: 0, insert: 'oi' });
    input.press('ENTER');
    input.sendKey('TAB');
    expect(store.sendKey).not.toHaveBeenCalled();
    answer();
    await flush();
    expect(store.sendKey.mock.calls).toEqual([
      ['ENTER', []],
      ['TAB', []],
    ]);
  });

  it('press spends the armed keys and sendKey does not (the caller already spent them)', async () => {
    const armed = TestBed.inject(PcArmed);
    armed.toggle('CTRL');
    input.press('A');
    expect(store.sendKey).toHaveBeenLastCalledWith('A', ['CTRL']);
    expect(armed.has('CTRL')).toBe(false);
    await flush();
    armed.toggle('ALT');
    input.sendKey('B', ['SHIFT']);
    expect(store.sendKey).toHaveBeenLastCalledWith('B', ['SHIFT']);
    expect(armed.has('ALT')).toBe(true);
  });

  it('press does nothing, and spends nothing, with the PC away', () => {
    store.phase.set('offline');
    TestBed.inject(PcArmed).toggle('CTRL');
    expect(input.press('A')).toBe(false);
    expect(store.sendKey).not.toHaveBeenCalled();
    expect(TestBed.inject(PcArmed).has('CTRL')).toBe(true);
    expect(input.canSend).toBe(false);
  });

  it('tells the listeners about a failure, with what failed, until they stop listening', async () => {
    const seen: [string, string][] = [];
    const stop = input.onFailure((failure, kind) => seen.push([failure.kind, kind]));
    store.sendKey.mockResolvedValueOnce({ kind: 'timeout', message: 'Tempo.' });
    input.sendKey('ENTER');
    await flush();
    store.sendText.mockResolvedValueOnce({ kind: 'network', message: 'Rede.' });
    input.edit({ erase: 0, insert: 'a' });
    await flush();
    expect(seen).toEqual([
      ['timeout', 'key'],
      ['network', 'edit'],
    ]);
    stop();
    store.sendKey.mockResolvedValueOnce({ kind: 'timeout', message: 'Tempo.' });
    input.sendKey('ENTER');
    await flush();
    expect(seen).toHaveLength(2);
  });

  it('tells the listeners when the line goes quiet', async () => {
    let idles = 0;
    input.onIdle(() => idles++);
    input.sendKey('ENTER');
    await flush();
    expect(idles).toBe(1);
  });

  it('counts what is waiting', () => {
    store.sendKey.mockReturnValue(new Promise(() => undefined));
    input.sendKey('BACKSPACE');
    input.sendKey('BACKSPACE');
    input.sendKey('BACKSPACE');
    expect(input.pending).toBe(3);
  });

  it('what is still waiting never reaches the PC of the next person when the account changes', async () => {
    let answer!: () => void;
    store.sendText.mockImplementationOnce(
      () => new Promise((resolve) => (answer = () => resolve(null))),
    );
    input.edit({ erase: 0, insert: 'a' });
    input.sendKey('ENTER');
    input.sendKey('TAB');
    signIn('bia');
    TestBed.tick();
    answer();
    await flush();
    expect(store.sendKey).not.toHaveBeenCalled();
    expect(input.pending).toBe(0);
    // A pessoa nova digita normalmente.
    input.sendKey('ESCAPE');
    expect(store.sendKey).toHaveBeenCalledExactlyOnceWith('ESCAPE', []);
  });

  it('a request made in the moment between the account change and the clean-up is cancelled, not sent', async () => {
    let answer!: () => void;
    store.sendText.mockImplementationOnce(
      () => new Promise((resolve) => (answer = () => resolve(null))),
    );
    input.edit({ erase: 0, insert: 'a' });
    input.sendKey('ENTER');
    // A conta troca e o próximo passo da fila sai antes de o app limpar a fila.
    signIn('bia');
    answer();
    await flush();
    expect(store.sendKey).not.toHaveBeenCalled();
  });
});

describe('PcInput: text changed outside the field', () => {
  let store: FakePcStore;
  let input: PcInput;
  let diverged: number;

  beforeEach(() => {
    store = createFakePcStore();
    TestBed.configureTestingModule({ providers: [{ provide: PcStore, useValue: store }] });
    input = TestBed.inject(PcInput);
    diverged = 0;
    input.onDiverge(() => diverged++);
  });

  it('a key with a modifier, from the screen, tells the field to start over', () => {
    TestBed.inject(PcArmed).toggle('CTRL');
    input.press('BACKSPACE');
    expect(diverged).toBe(1);
  });

  it('a plain key does not', () => {
    input.press('ENTER');
    expect(diverged).toBe(0);
  });

  it('any shortcut does, even one with no modifier (Space in a video, F5)', () => {
    input.shortcut('F5', []);
    expect(diverged).toBeGreaterThan(0);
  });

  it('a shortcut with the PC away sends nothing and tells nothing', () => {
    store.phase.set('offline');
    expect(input.shortcut('C', ['CTRL'])).toBe(false);
    expect(diverged).toBe(0);
  });

  it('stops telling once the listener is gone', () => {
    let seen = 0;
    const stop = input.onDiverge(() => seen++);
    input.diverge();
    stop();
    input.diverge();
    expect(seen).toBe(1);
  });
});
