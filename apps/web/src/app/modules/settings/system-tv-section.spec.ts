import { HttpErrorResponse } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { ApiProblem, problemFrom } from '../../core/auth/api-problem';
import { ConnectivityService } from '../../core/connectivity/connectivity.service';
import { SessionState } from '../../core/session/session-state';
import { SystemApi, TvConfig } from './system-api';
import { SystemTvSection } from './system-tv-section';

const CASA = { slug: 'pc-casa', name: 'PC de casa', platform: 'windows', online: true };
const NOVO = { slug: 'pc-novo', name: 'Notebook', platform: 'windows', online: false };

function config(overrides: Partial<TvConfig> = {}): TvConfig {
  return {
    name: 'TV',
    agentSlug: 'pc-casa',
    agentName: 'PC de casa',
    source: 'saved',
    agentStatus: 'online',
    agents: [CASA, NOVO],
    ...overrides,
  };
}

describe('SystemTvSection', () => {
  const api = { tvConfig: vi.fn(), bindTvComputer: vi.fn() };

  beforeEach(() => {
    api.tvConfig.mockReset().mockResolvedValue(config());
    api.bindTvComputer.mockReset();
    TestBed.configureTestingModule({
      providers: [provideRouter([]), { provide: SystemApi, useValue: api }],
    });
  });

  function signIn(role: 'owner' | 'guest' | null = 'owner') {
    const session = TestBed.inject(SessionState);
    if (role) {
      session.setToken('t', 600);
      session.setUser({ id: '1', email: 'a@b.c', displayName: 'Dono', role });
    }
    return session;
  }

  async function render() {
    const fixture = TestBed.createComponent(SystemTvSection);
    await fixture.whenStable();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    const save = () => el.querySelector<HTMLButtonElement>('button.save');
    const radios = () => Array.from(el.querySelectorAll<HTMLInputElement>('input[type="radio"]'));
    const text = () => el.textContent?.replace(/\s+/g, ' ') ?? '';
    return { fixture, el, save, radios, text };
  }

  it('loads for the administrator and shows the computer that controls the TV, its state and where it comes from', async () => {
    signIn();
    const { el, text } = await render();
    expect(api.tvConfig).toHaveBeenCalledTimes(1);
    expect(el.querySelector('.name')?.textContent).toBe('PC de casa');
    expect(el.querySelector('.current .chip')?.textContent?.trim()).toBe('Ligado');
    expect(text()).toContain('Escolhido aqui, no app.');
    expect(el.querySelector('.warning')).toBeNull();
  });

  it('never calls the API for a guest or while the role is unknown', async () => {
    signIn('guest');
    await render();
    expect(api.tvConfig).not.toHaveBeenCalled();
  });

  it('never calls the API without a session', async () => {
    signIn(null);
    await render();
    expect(api.tvConfig).not.toHaveBeenCalled();
  });

  it('lists the paired computers with name, system and whether each is on, and preselects the current one', async () => {
    signIn();
    const { el, radios } = await render();
    const rows = Array.from(el.querySelectorAll('.choice'));
    expect(rows.map((r) => r.querySelector('.ui-row-title')?.textContent)).toEqual([
      'PC de casa',
      'Notebook',
    ]);
    expect(rows.map((r) => r.querySelector('.chip')?.textContent?.trim())).toEqual([
      'Ligado',
      'Desligado',
    ]);
    expect(rows[0].querySelector('.ui-row-sub')?.textContent).toBe('Windows');
    expect(radios().map((r) => r.checked)).toEqual([true, false]);
  });

  it('keeps Salvar disabled until a different computer is chosen, then saves it', async () => {
    signIn();
    api.bindTvComputer.mockResolvedValue(
      config({ agentSlug: 'pc-novo', agentName: 'Notebook', agentStatus: 'offline' }),
    );
    const { fixture, el, save, radios, text } = await render();
    expect(save()!.disabled).toBe(true);

    radios()[1].click();
    fixture.detectChanges();
    expect(save()!.disabled).toBe(false);

    save()!.click();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(el.querySelector('.name')?.textContent).toBe('Notebook');
    });
    expect(api.bindTvComputer).toHaveBeenCalledExactlyOnceWith('pc-novo');
    expect(text()).toContain('Pronto: agora Notebook controla a TV.');
    expect(save()!.disabled).toBe(true);
    expect(el.querySelector('.current .chip')?.textContent?.trim()).toBe('Desligado');
  });

  it('explains that a computer that is only off is not a problem', async () => {
    signIn();
    api.tvConfig.mockResolvedValue(config({ agentStatus: 'offline' }));
    const { el, text } = await render();
    expect(text()).toContain('Está desligado agora. A TV volta a responder quando ele ligar.');
    expect(el.querySelector('.warning')).toBeNull();
  });

  it('lets the administrator keep a value that comes from the server in the app: saving the same computer is allowed', async () => {
    signIn();
    api.tvConfig.mockResolvedValue(config({ source: 'environment' }));
    api.bindTvComputer.mockResolvedValue(config());
    const { fixture, el, save, text } = await render();
    expect(text()).toContain(
      'Vem da configuração do servidor. Salve aqui para guardar a escolha no app.',
    );
    expect(save()!.disabled).toBe(false);

    save()!.click();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(el.textContent).toContain('Escolhido aqui, no app.');
    });
    expect(api.bindTvComputer).toHaveBeenCalledExactlyOnceWith('pc-casa');
    expect(save()!.disabled).toBe(true);
  });

  it('warns clearly when the current computer was revoked, and asks for a new choice', async () => {
    signIn();
    api.tvConfig.mockResolvedValue(config({ agentStatus: 'revoked', agents: [NOVO] }));
    const { el, save, radios, text } = await render();
    expect(el.querySelector('.warning')?.textContent).toContain(
      'Este computador foi revogado. A TV não vai responder até você escolher outro computador ou parear de novo em Aparelhos.',
    );
    expect(el.querySelector('.current .chip')?.textContent?.trim()).toBe('Revogado');
    expect(radios().map((r) => r.checked)).toEqual([false]);
    expect(save()!.disabled).toBe(true);
    expect(text()).toContain('PC de casa');
  });

  it('warns when the computer is not among the paired devices', async () => {
    signIn();
    api.tvConfig.mockResolvedValue(
      config({
        agentSlug: 'fantasma',
        agentName: null,
        agentStatus: 'unknown',
        source: 'environment',
      }),
    );
    const { el } = await render();
    expect(el.querySelector('.name')?.textContent).toBe('Computador não encontrado');
    expect(el.querySelector('.warning')?.textContent).toContain(
      'A TV não vai responder até você escolher outro computador ou parear de novo em Aparelhos.',
    );
  });

  it('warns when nothing is chosen yet, and shows no state chip', async () => {
    signIn();
    api.tvConfig.mockResolvedValue(
      config({ agentSlug: null, agentName: null, agentStatus: 'unknown', source: 'none' }),
    );
    const { el } = await render();
    expect(el.querySelector('.name')?.textContent).toBe('Nenhum computador escolhido');
    expect(el.querySelector('.current .chip')).toBeNull();
    expect(el.querySelector('.warning')?.textContent).toContain('Nenhum computador controla a TV.');
  });

  it('explains the empty state and sends the administrator to Aparelhos, with no save button', async () => {
    signIn();
    api.tvConfig.mockResolvedValue(
      config({
        agentSlug: null,
        agentName: null,
        agentStatus: 'unknown',
        source: 'none',
        agents: [],
      }),
    );
    const { el, save } = await render();
    expect(el.textContent).toContain(
      'Nenhum computador pareado. Pareie o computador de casa em Aparelhos',
    );
    expect(save()).toBeNull();
    const link = el.querySelector<HTMLAnchorElement>('a.devices-link')!;
    expect(link.getAttribute('href')).toBe('/ajustes/aparelhos');
    expect(link.textContent?.trim()).toBe('Ir para Aparelhos');
  });

  it('links to Aparelhos to pair another computer when there are some', async () => {
    signIn();
    const { el } = await render();
    const link = el.querySelector<HTMLAnchorElement>('a.devices-link')!;
    expect(link.getAttribute('href')).toBe('/ajustes/aparelhos');
    expect(link.textContent?.trim()).toBe('Parear outro computador');
  });

  it('shows a loading state, then an error with a retry when the configuration cannot be loaded', async () => {
    signIn();
    api.tvConfig.mockRejectedValueOnce(new HttpErrorResponse({ status: 0 }));
    const { fixture, el } = await render();
    expect(el.querySelector('[role="alert"]')?.textContent).toContain(
      'Não foi possível carregar a configuração da TV agora.',
    );
    el.querySelector<HTMLButtonElement>('button.retry')!.click();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(el.querySelector('.name')?.textContent).toBe('PC de casa');
    });
    expect(el.querySelector('[role="alert"]')).toBeNull();
  });

  it('shows a loading indicator while the configuration is on its way', () => {
    signIn();
    api.tvConfig.mockReturnValue(new Promise(() => undefined));
    const fixture = TestBed.createComponent(SystemTvSection);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('[role="status"]')?.textContent).toContain('Carregando…');
    expect(el.querySelector('.skeleton-card')).not.toBeNull();
  });

  it('says the change was not made when the passkey confirmation is missing or cancelled', async () => {
    signIn();
    api.bindTvComputer.mockRejectedValue(problemFrom(403, { type: 'x/step-up-required' }, null));
    const { fixture, el, save, radios } = await render();
    radios()[1].click();
    fixture.detectChanges();
    save()!.click();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(el.querySelector('.message')?.textContent).toContain('A troca não foi feita');
    });
    expect(el.querySelector('.name')?.textContent).toBe('PC de casa');
    expect(el.querySelector('.message')?.getAttribute('role')).toBe('alert');
  });

  it('reloads the list when the chosen computer is no longer valid', async () => {
    signIn();
    api.bindTvComputer.mockRejectedValue(problemFrom(400, { errors: { agentSlug: ['x'] } }, null));
    const { fixture, el, save, radios } = await render();
    api.tvConfig.mockResolvedValue(config({ agents: [CASA] }));
    radios()[1].click();
    fixture.detectChanges();
    save()!.click();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(el.querySelectorAll('.choice')).toHaveLength(1);
    });
    expect(el.querySelector('.message')?.textContent).toContain(
      'não está mais na lista de pareados',
    );
    expect(api.tvConfig).toHaveBeenCalledTimes(2);
  });

  it.each([
    [new ApiProblem(429, 'rate-limited', 'x'), 'Muitas tentativas seguidas'],
    [new ApiProblem(0, 'network', 'x'), 'Sem conexão com o servidor'],
    [new ApiProblem(500, 'internal', 'x'), 'Não foi possível salvar agora'],
  ])('says what went wrong for %#', async (problem, expected) => {
    signIn();
    api.bindTvComputer.mockRejectedValue(problem);
    const { fixture, el, save, radios } = await render();
    radios()[1].click();
    fixture.detectChanges();
    save()!.click();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(el.querySelector('.message')?.textContent).toContain(expected);
    });
  });

  it('does not save twice while a save is in flight', async () => {
    signIn();
    let finish!: (value: TvConfig) => void;
    api.bindTvComputer.mockReturnValue(new Promise<TvConfig>((resolve) => (finish = resolve)));
    const { fixture, el, save, radios } = await render();
    radios()[1].click();
    fixture.detectChanges();
    save()!.click();
    fixture.detectChanges();
    expect(save()!.disabled).toBe(true);
    expect(el.querySelector('button.save')?.textContent).toContain('Salvando…');
    save()!.click();
    expect(api.bindTvComputer).toHaveBeenCalledTimes(1);
    finish(config({ agentSlug: 'pc-novo', agentName: 'Notebook' }));
    await fixture.whenStable();
  });

  it('disables saving without a network, with an explanation', async () => {
    signIn();
    const { fixture, el, save, radios } = await render();
    radios()[1].click();
    TestBed.inject(ConnectivityService).online.set(false);
    fixture.detectChanges();
    expect(save()!.disabled).toBe(true);
    expect(el.textContent).toContain('Sem conexão: salvar precisa de rede.');
  });

  it('uses plain words: no technical terms on the screen', async () => {
    signIn();
    api.tvConfig.mockResolvedValue(config({ source: 'environment' }));
    const { text } = await render();
    for (const term of ['slug', 'agente', 'agent', 'variável', 'env', 'passkey']) {
      expect(text().toLowerCase()).not.toContain(term);
    }
  });
});
