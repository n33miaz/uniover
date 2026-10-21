import { TestBed } from '@angular/core/testing';
import { SessionState } from '../../../core/session/session-state';
import { TvAccess } from './tv-access';

describe('TvAccess', () => {
  const session = () => TestBed.inject(SessionState);
  const access = () => TestBed.inject(TvAccess);
  const guest = (permissions: readonly string[]) =>
    session().setUser({ id: '1', email: 'a@b.c', displayName: 'A', role: 'guest', permissions });
  const snapshot = () => ({
    view: access().view(),
    control: access().control(),
    power: access().power(),
    launch: access().launch(),
    edit: access().editShortcuts(),
    history: access().history(),
    list: access().appList(),
    apps: access().apps(),
  });
  const all = {
    view: true,
    control: true,
    power: true,
    launch: true,
    edit: true,
    history: true,
    list: true,
    apps: true,
  };

  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it('lets the owner do everything', () => {
    session().setUser({
      id: '1',
      email: 'a@b.c',
      displayName: 'A',
      role: 'owner',
      permissions: [
        'module:tv',
        'tv:control',
        'tv:power',
        'tv:launch',
        'tv:edit-shortcuts',
        'tv:history',
        'module:training',
      ],
    });
    expect(snapshot()).toEqual(all);
  });

  it('does not hide anything before the account is known', () => {
    expect(snapshot()).toEqual(all);
  });

  it('maps each permission to its own action, with the view as the base', () => {
    guest(['module:tv', 'tv:control']);
    expect(snapshot()).toEqual({
      view: true,
      control: true,
      power: false,
      launch: false,
      edit: false,
      history: false,
      // Só controla: sem grade de apps, mas o painel dos três pontos existe (a limpeza da TV mora nele).
      list: false,
      apps: true,
    });
    guest(['module:tv', 'tv:launch', 'tv:edit-shortcuts']);
    expect(snapshot()).toEqual({
      view: true,
      control: false,
      power: false,
      launch: true,
      edit: true,
      history: false,
      list: true,
      apps: true,
    });
    guest(['module:tv', 'tv:power', 'tv:history']);
    expect(snapshot()).toMatchObject({ power: true, history: true, list: false, apps: false });
  });

  it('opens the Apps panel for editing alone, since the edit mode lives there', () => {
    guest(['module:tv', 'tv:edit-shortcuts']);
    expect(access().apps()).toBe(true);
    expect(access().appList()).toBe(true);
  });

  it('control alone opens the panel of the three dots, but with no app list: it holds only the cleaning', () => {
    guest(['module:tv', 'tv:control']);
    expect(access().apps()).toBe(true);
    expect(access().appList()).toBe(false);
  });

  it('with only the view, nothing else is allowed', () => {
    guest(['module:tv']);
    expect(snapshot()).toEqual({
      view: true,
      control: false,
      power: false,
      launch: false,
      edit: false,
      history: false,
      list: false,
      apps: false,
    });
  });

  it('an action without the view is not allowed, even if the list carries it (the API drops it too)', () => {
    guest(['tv:control', 'tv:power', 'tv:launch', 'tv:edit-shortcuts', 'tv:history']);
    expect(snapshot()).toEqual({
      view: false,
      control: false,
      power: false,
      launch: false,
      edit: false,
      history: false,
      list: false,
      apps: false,
    });
  });

  it('a guest who only has the training module has no TV at all', () => {
    guest(['module:training']);
    expect(access().view()).toBe(false);
  });

  it('follows the session when the permissions change', () => {
    guest(['module:tv']);
    expect(access().control()).toBe(false);
    guest(['module:tv', 'tv:control']);
    expect(access().control()).toBe(true);
    guest(['module:training']);
    expect(access().control()).toBe(false);
    expect(access().view()).toBe(false);
  });
});
