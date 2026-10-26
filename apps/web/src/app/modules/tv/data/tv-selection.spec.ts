import { TestBed } from '@angular/core/testing';
import { SessionState } from '../../../core/session/session-state';
import { TvSelection, tvSelectedStorageKey } from './tv-selection';
import { TvSummary } from './tv-types';

const tv = (id: string, overrides: Partial<TvSummary> = {}): TvSummary => ({
  id,
  name: `TV ${id}`,
  isDefault: false,
  agentSlug: null,
  kind: 'android',
  online: true,
  capabilities: [],
  ...overrides,
});

const HOME = tv('home', { isDefault: true });
const FRIEND = tv('friend', { kind: 'samsung' });

describe('TvSelection', () => {
  const identify = (id = 'conta-1') =>
    TestBed.inject(SessionState).setUser({ id, email: `${id}@example.com`, displayName: 'A' });
  const fresh = (account = 'conta-1') => {
    TestBed.resetTestingModule();
    identify(account);
    return TestBed.inject(TvSelection);
  };
  const stored = (account = 'conta-1') =>
    JSON.parse(localStorage.getItem(tvSelectedStorageKey(account)) ?? 'null');

  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it('knows nothing before the list arrives, and then sends no tv id', () => {
    const selection = fresh();
    expect(selection.tvs()).toBeNull();
    expect(selection.selected()).toBeNull();
    expect(selection.multiple()).toBe(false);
    expect(selection.tvId()).toBeNull();
    expect(selection.scope()).toBeNull();
  });

  it('sends no tv id with a single TV, whichever it is', () => {
    const selection = fresh();
    selection.setTvs([FRIEND]);
    expect(selection.selected()?.id).toBe('friend');
    expect(selection.multiple()).toBe(false);
    expect(selection.tvId()).toBeNull();
  });

  it('with several TVs picks the default first, and sends its id', () => {
    const selection = fresh();
    selection.setTvs([FRIEND, HOME]);
    expect(selection.multiple()).toBe(true);
    expect(selection.selected()?.id).toBe('home');
    expect(selection.tvId()).toBe('home');
  });

  it('falls back to the first of the list when there is no default among the visible ones', () => {
    const selection = fresh();
    selection.setTvs([FRIEND, tv('other')]);
    expect(selection.selected()?.id).toBe('friend');
  });

  it('keeps the choice per account on this device and ignores an id that is not in the list', () => {
    const selection = fresh();
    selection.setTvs([HOME, FRIEND]);
    selection.select('friend');
    expect(selection.selected()?.id).toBe('friend');
    expect(stored()).toEqual({ id: 'friend', isDefault: false });

    selection.select('nao-existe');
    expect(selection.selected()?.id).toBe('friend');
    expect(stored()).toEqual({ id: 'friend', isDefault: false });
  });

  it('restores the choice of the account on the next visit, and opens already on that TV', () => {
    const first = fresh();
    first.setTvs([HOME, FRIEND]);
    first.select('friend');

    const next = fresh();
    // Antes da lista chegar o fluxo já abre na TV certa, e a chave das preferências também é a dela.
    expect(next.tvId()).toBe('friend');
    expect(next.scope()).toBe('friend');
    next.setTvs([HOME, FRIEND]);
    expect(next.selected()?.id).toBe('friend');
  });

  it('forgets the list of TVs when another account signs in on the same page, without reloading', () => {
    // O mesmo injetor de ponta a ponta (sem `fresh`): é o que acontece quando A sai e B entra sem recarregar a página.
    const selection = fresh('conta-1');
    selection.setTvs([HOME, FRIEND]);
    selection.select('friend');
    expect(selection.tvId()).toBe('friend');

    identify('conta-2');
    expect(selection.tvs()).toBeNull();
    expect(selection.selected()).toBeNull();
    expect(selection.multiple()).toBe(false);
    // Nada da lista de A vira o `tvId` das chamadas de B (nem a escolha de A, que fica guardada para A).
    expect(selection.tvId()).toBeNull();
    expect(selection.scope()).toBeNull();

    selection.setTvs([HOME, FRIEND]);
    expect(selection.selected()?.id).toBe('home');
    identify('conta-1');
    expect(selection.tvs()).toBeNull();
    expect(stored('conta-1')).toEqual({ id: 'friend', isDefault: false });
  });

  it('does not leak the choice to another account', () => {
    const first = fresh('conta-1');
    first.setTvs([HOME, FRIEND]);
    first.select('friend');

    const other = fresh('conta-2');
    other.setTvs([HOME, FRIEND]);
    expect(other.selected()?.id).toBe('home');
  });

  it('goes back to the default, without error, when the saved TV is gone', () => {
    const first = fresh();
    first.setTvs([HOME, FRIEND]);
    first.select('friend');

    const next = fresh();
    next.setTvs([HOME, tv('another')]);
    expect(next.selected()?.id).toBe('home');
    expect(next.tvId()).toBe('home');
    // A escolha guardada não é apagada: a TV pode voltar a aparecer.
    expect(stored()).toEqual({ id: 'friend', isDefault: false });
    next.setTvs([HOME, FRIEND]);
    expect(next.selected()?.id).toBe('friend');
  });

  it('gives the default TV the old keys (no scope) and every other TV its own', () => {
    const selection = fresh();
    selection.setTvs([HOME, FRIEND]);
    expect(selection.scope()).toBeNull();
    selection.select('friend');
    expect(selection.scope()).toBe('friend');
    selection.select('home');
    expect(selection.scope()).toBeNull();
  });

  it('ignores a corrupted stored choice', () => {
    localStorage.setItem(tvSelectedStorageKey('conta-1'), '{nao e json');
    const selection = fresh();
    selection.setTvs([HOME, FRIEND]);
    expect(selection.selected()?.id).toBe('home');
  });
});
