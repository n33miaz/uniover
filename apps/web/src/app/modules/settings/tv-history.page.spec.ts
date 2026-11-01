import { HttpErrorResponse } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap } from '@angular/router';
import { AuthApi, GuestSummary } from '../../core/auth/auth-api';
import { AuthService } from '../../core/auth/auth.service';
import { SessionState } from '../../core/session/session-state';
import { SystemApi, TvHistoryItem, TvItem } from './system-api';
import { TvHistoryPage } from './tv-history.page';

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

const row = (
  extra: Partial<TvHistoryItem> & Pick<TvHistoryItem, 'id' | 'command'>,
): TvHistoryItem => ({
  userId: 'g1',
  detail: null,
  ok: true,
  errorCode: null,
  occurredAt: '2026-10-31T20:00:00Z',
  ...extra,
});

const guest = (id: string, displayName: string): GuestSummary => ({
  id,
  displayName,
  email: `${id}@exemplo.com`,
  createdAt: '2026-10-19T15:00:00Z',
  disabledAt: null,
  pausedAt: null,
  permissions: ['module:tv'],
});

describe('TvHistoryPage', () => {
  const api = { tvs: vi.fn(), tvHistory: vi.fn() };
  const authApi = { guests: vi.fn() };

  beforeEach(() => {
    api.tvs.mockReset().mockResolvedValue([SALA]);
    api.tvHistory.mockReset().mockResolvedValue([
      row({
        id: 'h3',
        command: 'tv.text',
        detail: 'length=5',
        ok: false,
        errorCode: 'TV_UNREACHABLE',
      }),
      row({ id: 'h2', command: 'tv.power-off', userId: 'u1' }),
      row({ id: 'h1', command: 'tv.key', detail: 'VOLUME_UP/SHORT', userId: 'gone' }),
    ]);
    authApi.guests.mockReset().mockResolvedValue([guest('g1', 'Bruno')]);
  });

  function setup(role: 'owner' | 'guest' = 'owner', id: string | null = 'tv-sala') {
    TestBed.configureTestingModule({
      providers: [
        { provide: SystemApi, useValue: api },
        { provide: AuthApi, useValue: authApi },
        {
          provide: AuthService,
          useValue: { authorized: (call: (t: string) => unknown) => call('token') },
        },
        {
          provide: ActivatedRoute,
          useValue: { snapshot: { paramMap: convertToParamMap(id ? { id } : {}) } },
        },
      ],
    });
    const session = TestBed.inject(SessionState);
    session.setToken('t', 600);
    session.setUser({ id: 'u1', email: 'a@b.c', displayName: 'Neemias', role });
  }

  async function render() {
    const fixture = TestBed.createComponent(TvHistoryPage);
    const settle = async () => {
      await fixture.whenStable();
      fixture.detectChanges();
      await fixture.whenStable();
      fixture.detectChanges();
    };
    await settle();
    const el = fixture.nativeElement as HTMLElement;
    const entries = () =>
      Array.from(el.querySelectorAll<HTMLElement>('li.entry')).map((li) => ({
        title: li.querySelector('.ui-row-title')?.textContent?.trim(),
        subs: Array.from(li.querySelectorAll('.ui-row-sub')).map((s) => s.textContent?.trim()),
        result: li.querySelector('.result')?.textContent?.trim(),
      }));
    return { el, settle, entries };
  }

  it('lists who did what and the result, newest first, with names from the people list', async () => {
    setup();
    const { entries, el } = await render();
    expect(api.tvHistory).toHaveBeenCalledExactlyOnceWith('tv-sala');
    expect(el.querySelector('.tv-name')?.textContent?.trim()).toBe('Sala');
    const list = entries();
    expect(list.map((entry) => entry.title)).toEqual([
      'Texto enviado à TV',
      'TV desligada',
      'Tecla enviada à TV',
    ]);
    expect(list[0].subs[0]).toBe('5 caracteres');
    expect(list[0].subs[1]).toContain('Bruno');
    expect(list[0].result).toBe('Erro');
    // O próprio administrador entra pelo nome da sessão; uma conta que não existe mais, sem inventar nome.
    expect(list[1].subs[0]).toContain('Neemias');
    expect(list[1].result).toBe('Sucesso');
    expect(list[2].subs.join(' ')).toContain('Conta removida');
    expect(list[2].subs[0]).toBe('Tecla volume up');
  });

  it('shows an empty state when the TV has no history yet', async () => {
    api.tvHistory.mockResolvedValue([]);
    setup();
    const { el } = await render();
    expect(el.textContent).toContain('Nada por aqui ainda.');
    expect(el.querySelector('li.entry')).toBeNull();
  });

  it('says the TV is gone when it is not in the list, without listing anything', async () => {
    api.tvs.mockResolvedValue([]);
    setup();
    const { el } = await render();
    expect(el.querySelector('[role="alert"]')?.textContent).toContain('Essa TV não existe mais.');
    expect(el.querySelector('button.retry')).toBeNull();
  });

  it('says the TV is gone when the API answers 404 for it', async () => {
    api.tvHistory.mockRejectedValue(new HttpErrorResponse({ status: 404 }));
    setup();
    const { el } = await render();
    expect(el.querySelector('[role="alert"]')?.textContent).toContain('Essa TV não existe mais.');
  });

  it('shows the failure with Tentar de Novo and recovers on the retry', async () => {
    api.tvHistory.mockRejectedValueOnce(new Error('falhou'));
    setup();
    const { el, settle } = await render();
    expect(el.querySelector('[role="alert"]')?.textContent).toContain(
      'Não foi possível carregar agora.',
    );

    el.querySelector<HTMLButtonElement>('button.retry')!.click();
    await settle();
    expect(el.querySelectorAll('li.entry')).toHaveLength(3);
  });

  it('never calls the API for an account that is not the administrator', async () => {
    setup('guest');
    await render();
    expect(api.tvHistory).not.toHaveBeenCalled();
    expect(api.tvs).not.toHaveBeenCalled();
  });
});
