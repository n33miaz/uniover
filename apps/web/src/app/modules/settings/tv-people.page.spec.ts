import { TestBed } from '@angular/core/testing';
import { AuthApi, GuestSummary } from '../../core/auth/auth-api';
import { AuthService } from '../../core/auth/auth.service';
import { SessionState } from '../../core/session/session-state';
import { SystemApi, TvComputer, TvConfig, TvItem } from './system-api';
import { TvPeoplePage } from './tv-people.page';

const CASA_PC: TvComputer = {
  slug: 'pc-casa',
  name: 'PC de casa',
  platform: 'windows',
  online: true,
};
const AMIGO_PC: TvComputer = {
  slug: 'pc-amigo',
  name: 'PC do Raphael',
  platform: 'windows',
  online: false,
};

const SALA: TvItem = {
  id: 'tv-sala',
  name: 'Sala',
  isDefault: true,
  agentSlug: 'pc-casa',
  kind: 'android',
  online: true,
  capabilities: [],
  allowBackgroundAppClosing: false,
};
const QUARTO: TvItem = {
  id: 'tv-quarto',
  name: 'Quarto',
  isDefault: false,
  agentSlug: 'pc-amigo',
  kind: 'samsung',
  online: false,
  capabilities: [],
  allowBackgroundAppClosing: false,
};

const guest = (
  id: string,
  displayName: string,
  permissions: string[],
  extra: Partial<GuestSummary> = {},
): GuestSummary => ({
  id,
  displayName,
  email: `${id}@exemplo.com`,
  createdAt: '2026-10-19T15:00:00Z',
  disabledAt: null,
  pausedAt: null,
  permissions,
  ...extra,
});

function config(agents: TvComputer[]): TvConfig {
  return {
    name: 'TV',
    agentSlug: 'pc-casa',
    agentName: 'PC de casa',
    source: 'saved',
    agentStatus: 'online',
    agents,
  };
}

describe('TvPeoplePage', () => {
  const api = { tvs: vi.fn(), tvConfig: vi.fn(), tvAccess: vi.fn() };
  const authApi = { guests: vi.fn() };

  beforeEach(() => {
    api.tvs.mockReset().mockResolvedValue([SALA, QUARTO]);
    api.tvConfig.mockReset().mockResolvedValue(config([CASA_PC, AMIGO_PC]));
    api.tvAccess.mockReset().mockResolvedValue([
      { userId: 'g1', tvIds: ['tv-sala'] },
      { userId: 'g2', tvIds: ['tv-quarto'] },
      { userId: 'g4', tvIds: ['tv-sala'] },
    ]);
    authApi.guests
      .mockReset()
      .mockResolvedValue([
        guest('g1', 'Bruno', ['module:tv', 'tv:control']),
        guest('g2', 'Bia', ['module:tv']),
        guest('g3', 'Cris', ['module:training']),
        guest('g4', 'Duda', ['module:tv', 'tv:control'], { pausedAt: '2026-10-30T10:00:00Z' }),
        guest('g5', 'Antiga', ['module:tv'], { disabledAt: '2026-10-01T10:00:00Z' }),
      ]);
    TestBed.configureTestingModule({
      providers: [
        { provide: SystemApi, useValue: api },
        { provide: AuthApi, useValue: authApi },
        {
          provide: AuthService,
          useValue: { authorized: (call: (t: string) => unknown) => call('token') },
        },
      ],
    });
  });

  function signIn(role: 'owner' | 'guest' = 'owner') {
    const session = TestBed.inject(SessionState);
    session.setToken('t', 600);
    session.setUser({ id: 'u1', email: 'a@b.c', displayName: 'Neemias', role });
  }

  async function render() {
    const fixture = TestBed.createComponent(TvPeoplePage);
    const settle = async () => {
      await fixture.whenStable();
      fixture.detectChanges();
      await fixture.whenStable();
      fixture.detectChanges();
    };
    await settle();
    const el = fixture.nativeElement as HTMLElement;
    const people = () => Array.from(el.querySelectorAll<HTMLElement>('li.person'));
    const person = (name: string) =>
      people().find((li) => li.querySelector('.name')?.textContent?.trim() === name)!;
    const tvsOf = (name: string) =>
      Array.from(person(name).querySelectorAll<HTMLElement>('li.tv')).map((li) => ({
        title: li.querySelector('.ui-row-title')?.textContent?.trim(),
        sub: li.querySelector('.ui-row-sub')?.textContent?.trim(),
        access: li.querySelector('.chip')?.textContent?.trim(),
      }));
    return { fixture, el, settle, people, person, tvsOf };
  }

  it('lists the administrator first, with every TV, its computer and that they control it', async () => {
    signIn();
    const { person, tvsOf } = await render();
    expect(person('Neemias').textContent).toContain('Administrador');
    expect(tvsOf('Neemias')).toEqual([
      { title: 'Sala', sub: 'PC de casa · Android', access: 'Controla' },
      { title: 'Quarto', sub: 'PC do Raphael · Samsung', access: 'Controla' },
    ]);
  });

  it('shows each active person with the TVs the server says they see, and whether they control them', async () => {
    signIn();
    const { people, tvsOf } = await render();
    expect(people().map((li) => li.querySelector('.name')?.textContent?.trim())).toEqual([
      'Neemias',
      'Bruno',
      'Bia',
      'Cris',
      'Duda',
    ]);
    expect(tvsOf('Bruno')).toEqual([
      { title: 'Sala', sub: 'PC de casa · Android', access: 'Controla' },
    ]);
    expect(tvsOf('Bia')).toEqual([
      { title: 'Quarto', sub: 'PC do Raphael · Samsung', access: 'Só Vê' },
    ]);
    expect(api.tvAccess).toHaveBeenCalledExactlyOnceWith(['g1', 'g2', 'g3', 'g4']);
  });

  it('says so for who has no access to the TV, marks the paused and leaves out the deactivated', async () => {
    signIn();
    const { person, el } = await render();
    expect(person('Cris').textContent).toContain('Sem acesso à TV');
    expect(person('Duda').textContent).toContain('Pausado');
    expect(person('Duda').classList.contains('paused')).toBe(true);
    expect(el.textContent).not.toContain('Antiga');
  });

  it('shows the empty state when there is no TV at all', async () => {
    api.tvs.mockResolvedValue([]);
    api.tvAccess.mockResolvedValue([]);
    signIn();
    const { el } = await render();
    expect(el.textContent).toContain('Nenhuma TV ainda.');
    expect(el.querySelector('li.person')).toBeNull();
  });

  it('shows the failure with Tentar de Novo and recovers on the retry', async () => {
    api.tvAccess.mockRejectedValueOnce(new Error('falhou'));
    signIn();
    const { el, settle } = await render();
    expect(el.querySelector('[role="alert"]')?.textContent).toContain(
      'Não foi possível carregar agora.',
    );

    el.querySelector<HTMLButtonElement>('button.retry')!.click();
    await settle();
    expect(el.querySelector('[role="alert"]')).toBeNull();
    expect(el.querySelectorAll('li.person').length).toBeGreaterThan(0);
  });

  it('never calls the API for an account that is not the administrator', async () => {
    signIn('guest');
    await render();
    expect(api.tvs).not.toHaveBeenCalled();
    expect(api.tvAccess).not.toHaveBeenCalled();
    expect(authApi.guests).not.toHaveBeenCalled();
  });
});
