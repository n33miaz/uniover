import { TestBed } from '@angular/core/testing';
import { SessionState } from '../../../core/session/session-state';
import { TvAccess } from './tv-access';
import { TvSelection } from './tv-selection';
import { TvSummary } from './tv-types';

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
    list: access().appList(),
    apps: access().apps(),
  });
  const all = {
    view: true,
    control: true,
    power: true,
    launch: true,
    edit: true,
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
      // Só controla: sem grade de apps, e sem o painel Apps (a limpeza da TV é um item do menu, não dele).
      list: false,
      apps: false,
    });
    guest(['module:tv', 'tv:launch', 'tv:edit-shortcuts']);
    expect(snapshot()).toEqual({
      view: true,
      control: false,
      power: false,
      launch: true,
      edit: true,
      list: true,
      apps: true,
    });
    guest(['module:tv', 'tv:power']);
    expect(snapshot()).toMatchObject({ power: true, list: false, apps: false });
  });

  it('opens the Apps panel for editing alone, since the edit mode lives there', () => {
    guest(['module:tv', 'tv:edit-shortcuts']);
    expect(access().apps()).toBe(true);
    expect(access().appList()).toBe(true);
  });

  it('control alone has no Apps panel: the cleaning lives in the menu, not in it', () => {
    guest(['module:tv', 'tv:control']);
    expect(access().apps()).toBe(false);
    expect(access().appList()).toBe(false);
    expect(access().cleanup()).toBe(true);
  });

  it('with only the view, nothing else is allowed', () => {
    guest(['module:tv']);
    expect(snapshot()).toEqual({
      view: true,
      control: false,
      power: false,
      launch: false,
      edit: false,
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

describe('TvAccess with the capabilities of the TV in use', () => {
  const tv = (overrides: Partial<TvSummary>): TvSummary => ({
    id: 'tv',
    name: 'TV',
    isDefault: true,
    agentSlug: null,
    kind: 'android',
    online: true,
    capabilities: ['tv.remote', 'tv.kind.android', 'tv.adb'],
    ...overrides,
  });
  const owner = () =>
    TestBed.inject(SessionState).setUser({
      id: '1',
      email: 'a@b.c',
      displayName: 'A',
      role: 'owner',
      permissions: ['module:tv', 'tv:control', 'tv:power', 'tv:launch', 'tv:edit-shortcuts'],
    });
  const show = (item: TvSummary | null) => TestBed.inject(TvSelection).setTvs(item ? [item] : null);

  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it('keeps everything for an Android with ADB', () => {
    owner();
    show(tv({}));
    const access = TestBed.inject(TvAccess);
    expect([access.cleanup(), access.text(), access.appList(), access.apps()]).toEqual([
      true,
      true,
      true,
      true,
    ]);
  });

  it('takes the keyboard and the cleanup away from a Samsung, which still opens apps', () => {
    owner();
    show(tv({ kind: 'samsung', capabilities: ['tv.remote', 'tv.kind.samsung'] }));
    const access = TestBed.inject(TvAccess);
    expect(access.cleanup()).toBe(false);
    expect(access.text()).toBe(false);
    expect(access.appList()).toBe(true);
    expect(access.control()).toBe(true);
  });

  it('has no apps panel at all when the TV can neither list apps nor be cleaned', () => {
    owner();
    show(tv({ capabilities: ['tv.remote', 'tv.kind.android'] }));
    const access = TestBed.inject(TvAccess);
    expect(access.appList()).toBe(false);
    expect(access.cleanup()).toBe(false);
    expect(access.apps()).toBe(false);
  });

  it('does not hide anything while the agent is off and nothing is known about the TV', () => {
    owner();
    show(tv({ kind: null, capabilities: [], online: false }));
    const access = TestBed.inject(TvAccess);
    expect([access.cleanup(), access.text(), access.appList()]).toEqual([true, true, true]);
  });

  it('opens the network and settings screens only with control and an agent that declares it', () => {
    owner();
    const access = TestBed.inject(TvAccess);
    show(tv({ capabilities: ['tv.remote', 'tv.kind.android', 'tv.adb', 'tv.settings.open.v1'] }));
    expect(access.settings()).toBe(true);
    show(tv({}));
    expect(access.settings()).toBe(false);
    show(tv({ kind: 'samsung', capabilities: ['tv.remote', 'tv.kind.samsung'] }));
    expect(access.settings()).toBe(false);
    // Sem nada saber da TV (agente fora do ar) a linha não aparece: pedir a quem não a conhece não adianta.
    show(tv({ kind: null, capabilities: [], online: false }));
    expect(access.settings()).toBe(false);
    TestBed.inject(SessionState).setUser({
      id: '2',
      email: 'g@b.c',
      displayName: 'G',
      role: 'guest',
      permissions: ['module:tv'],
    });
    show(tv({ capabilities: ['tv.remote', 'tv.adb', 'tv.settings.open.v1'] }));
    expect(access.settings()).toBe(false);
  });

  it('offers the inputs list only with control and the INPUT key declared by the agent', () => {
    owner();
    const access = TestBed.inject(TvAccess);
    show(tv({ capabilities: ['tv.remote', 'tv.kind.android', 'tv.adb', 'tv.key.INPUT'] }));
    expect(access.inputs()).toBe(true);
    show(tv({}));
    expect(access.inputs()).toBe(false);
    show(tv({ kind: 'samsung', capabilities: ['tv.remote', 'tv.kind.samsung'] }));
    expect(access.inputs()).toBe(false);
    show(tv({ kind: null, capabilities: [], online: false }));
    expect(access.inputs()).toBe(false);
  });

  it('still needs the permission: the capability alone gives nothing', () => {
    TestBed.inject(SessionState).setUser({
      id: '2',
      email: 'g@b.c',
      displayName: 'G',
      role: 'guest',
      permissions: ['module:tv'],
    });
    show(tv({}));
    const access = TestBed.inject(TvAccess);
    expect([access.cleanup(), access.text(), access.appList()]).toEqual([false, false, false]);
  });
});
