import { HttpErrorResponse } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { routes } from '../../app.routes';
import { AuthApi } from '../../core/auth/auth-api';
import { AuthService } from '../../core/auth/auth.service';
import { ConnectivityService } from '../../core/connectivity/connectivity.service';
import { SessionState } from '../../core/session/session-state';
import { DeviceAgent, DevicesApi } from './devices-api';
import { DevicesPage } from './devices.page';

const PC: DeviceAgent = {
  id: 'a1',
  slug: 'agent:pc-de-casa',
  name: 'PC de casa',
  platform: 'windows',
  createdAt: '2026-10-18T12:00:00Z',
  revoked: false,
  lastSeenAt: '2026-10-19T09:00:00Z',
  connected: true,
  agentVersion: '0.1.0',
  agentBuild: '3f2a9c1d4e5b',
  os: 'Windows 11 (10.0.26200)',
  tvKind: 'android',
  tvHost: '192.168.0.20',
  canReadLogs: true,
  canMaintain: true,
  canRollback: false,
};

const INSTALLED = '3f2a9c1d4e5b6a7988776655443322110fedcba9';
const NEWER = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const PREVIOUS = '0a1b2c3d4e5f60718293a4b5c6d7e8f901234567';

function withUpdate(update: Partial<NonNullable<DeviceAgent['update']>>): DeviceAgent {
  return {
    ...PC,
    update: {
      state: 'current',
      installedSha: INSTALLED,
      installedAt: '2026-10-20T09:15:00Z',
      latestSha: INSTALLED,
      checkedAt: '2026-10-24T13:40:00Z',
      nextCheckAt: '2026-10-24T19:55:00Z',
      reason: null,
      blockedSha: null,
      previousSha: null,
      rolledBack: false,
      ...update,
    },
  };
}

describe('DevicesPage', () => {
  const api = {
    list: vi.fn(),
    approve: vi.fn(),
    deny: vi.fn(),
    revoke: vi.fn(),
    logs: vi.fn(),
    maintain: vi.fn(),
    alerts: vi.fn(),
    markAlertsSeen: vi.fn(),
    tvs: vi.fn(),
  };

  beforeEach(() => {
    api.logs
      .mockReset()
      .mockResolvedValue({ text: 'linha 1\nlinha 2', lines: 2, truncated: false, at: 'x' });
    api.maintain.mockReset().mockResolvedValue(undefined);
    api.alerts.mockReset().mockResolvedValue([]);
    api.markAlertsSeen.mockReset().mockResolvedValue(undefined);
    api.tvs.mockReset().mockResolvedValue([]);
    api.list.mockReset().mockResolvedValue([PC]);
    api.approve.mockReset().mockResolvedValue(undefined);
    api.deny.mockReset().mockResolvedValue(undefined);
    api.revoke.mockReset().mockResolvedValue(undefined);
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        { provide: DevicesApi, useValue: api },
        // A folha de aprovação lista as pessoas para "Para quem é a TV".
        { provide: AuthApi, useValue: { guests: vi.fn().mockResolvedValue([]) } },
        {
          provide: AuthService,
          useValue: { authorized: (call: (token: string) => unknown) => call('token') },
        },
      ],
    });
  });

  async function render() {
    const fixture = TestBed.createComponent(DevicesPage);
    await fixture.whenStable();
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    const button = (text: string | RegExp) =>
      Array.from(el.querySelectorAll<HTMLButtonElement>('button')).find((b) =>
        typeof text === 'string' ? b.textContent?.trim() === text : text.test(b.textContent ?? ''),
      )!;
    return { fixture, el, button };
  }

  it('lists the paired devices with state and last contact', async () => {
    const { el } = await render();
    const item = el.querySelector('.item')!;
    expect(item.querySelector('.name')?.textContent).toBe('PC de casa');
    expect(item.textContent).toContain('Pareado em');
    expect(item.textContent).toContain('Ativo');
    expect(item.querySelector('.last-seen')?.textContent).toContain('Visto há');
  });

  it('keeps the last known contact, version and update state visible for a disconnected computer', async () => {
    api.list.mockResolvedValue([{ ...withUpdate({}), connected: false }]);
    const { el } = await render();
    expect(el.querySelector('.last-seen')?.textContent).toContain('Visto há');
    expect(el.querySelector('.version')?.textContent).toContain('Versão 0.1.0');
    expect(el.querySelector('.update-state')?.textContent).toContain('Atualizado');
  });

  it('says so when the device has no recorded use yet', async () => {
    api.list.mockResolvedValue([{ ...PC, lastSeenAt: null }]);
    const { el } = await render();
    expect(el.querySelector('.last-seen')?.textContent).toContain('Sem contato registrado');
  });

  it('shows what the agent told about the computer: version, system, TV and connection', async () => {
    const { el } = await render();
    const item = el.querySelector('.item')!;
    expect(item.querySelector('.version')?.textContent).toBe('Versão 0.1.0 · 3f2a9c1');
    expect(item.textContent).toContain('Sistema: Windows 11 (10.0.26200)');
    expect(item.querySelector('.tv')?.textContent).toBe('TV: Android TV · 192.168.0.20');
    expect(item.querySelector('.chip.connection')?.textContent).toContain('Conectado agora');
  });

  it('falls back to the pairing platform and leaves out what an old agent never told', async () => {
    api.list.mockResolvedValue([
      {
        ...PC,
        connected: false,
        agentVersion: null,
        agentBuild: null,
        os: null,
        tvKind: null,
        tvHost: null,
        canReadLogs: false,
        canMaintain: false,
      },
    ]);
    const { el } = await render();
    const item = el.querySelector('.item')!;
    expect(item.textContent).toContain('Sistema: windows');
    expect(item.querySelector('.version')).toBeNull();
    expect(item.querySelector('.tv')).toBeNull();
    expect(item.querySelector('.chip.connection')?.textContent).toContain('Desconectado');
  });

  it('writes a Samsung TV and a version without a commit in plain words', async () => {
    api.list.mockResolvedValue([{ ...PC, agentBuild: null, tvKind: 'samsung' }]);
    const { el } = await render();
    expect(el.querySelector('.version')?.textContent).toBe('Versão 0.1.0');
    expect(el.querySelector('.tv')?.textContent).toBe('TV: Samsung · 192.168.0.20');
  });

  describe('update state', () => {
    async function updateText(agent: DeviceAgent): Promise<HTMLElement> {
      api.list.mockResolvedValue([agent]);
      const { el } = await render();
      return el.querySelector<HTMLElement>('.update')!;
    }

    it('says "Atualizado" with the installed version, when it was installed and the last check', async () => {
      const update = await updateText(withUpdate({}));
      expect(update.querySelector('.update-state')?.textContent).toContain('Atualizado');
      expect(update.querySelector('.update-state')?.classList).toContain('ok');
      expect(update.querySelector('.update-installed')?.textContent).toContain(
        'Instalada: 3f2a9c1',
      );
      expect(update.querySelector('.update-installed')?.textContent).toContain('2026');
      expect(update.querySelector('.update-newest')?.textContent).toContain('a mesma instalada');
      expect(update.querySelector('.update-check')?.textContent).toContain('sem novidade');
    });

    it('says "Atualizando…" while the check is running', async () => {
      const update = await updateText(withUpdate({ state: 'updating', latestSha: NEWER }));
      expect(update.querySelector('.update-state')?.textContent).toContain('Atualizando…');
      expect(update.querySelector('.update-check')?.textContent).toContain('em andamento');
    });

    it('says the update is pending, with the newer version and the next check', async () => {
      const update = await updateText(withUpdate({ state: 'pending', latestSha: NEWER }));
      const state = update.querySelector('.update-state')!;
      expect(state.textContent).toContain('Atualização pendente');
      expect(state.textContent).toContain('próxima checagem em');
      expect(state.classList).toContain('warn');
      expect(update.querySelector('.update-newest')?.textContent).toContain('a1b2c3d');
    });

    it('says why and when the update failed', async () => {
      const update = await updateText(
        withUpdate({
          state: 'failed',
          latestSha: NEWER,
          reason: 'não consegui baixar o pacote (ConnectError)',
        }),
      );
      const state = update.querySelector('.update-state')!;
      expect(state.textContent).toContain('Falhou: não consegui baixar o pacote (ConnectError)');
      expect(state.textContent).toMatch(/\(.*2026.*\)/);
      expect(state.classList).toContain('bad');
      expect(update.querySelector('.update-check')?.textContent).toContain('falhou');
    });

    it('tells a blocked version and a return to the previous one', async () => {
      const blocked = await updateText(
        withUpdate({ state: 'blocked', latestSha: NEWER, blockedSha: NEWER, rolledBack: true }),
      );
      expect(blocked.querySelector('.update-state')?.textContent).toContain('bloqueada');
      expect(blocked.querySelector('.update-rollback')?.textContent).toContain(
        'a versão a1b2c3d não será instalada de novo',
      );
    });

    it('says the agent is waiting for its first check', async () => {
      const update = await updateText(withUpdate({ state: 'unchecked', latestSha: null }));
      expect(update.querySelector('.update-state')?.textContent).toContain(
        'Aguardando a primeira checagem',
      );
      expect(update.querySelector('.update-newest')).toBeNull();
    });

    it('says "versão desconhecida" and asks to update an old agent that never told its state', async () => {
      const update = await updateText({ ...PC });
      expect(update.querySelector('.update-state')?.textContent).toContain(
        'Versão desconhecida: atualize o agente',
      );
      expect(update.querySelector('.update-state')?.classList).toContain('warn');
      expect(update.querySelector('.update-installed')).toBeNull();
    });

    it('shows nothing about updates for a computer that never connected', async () => {
      api.list.mockResolvedValue([{ ...PC, agentVersion: null, connected: false }]);
      const { el } = await render();
      expect(el.querySelector('.update')).toBeNull();
    });
  });

  describe('rollback', () => {
    it('offers going back only when the agent kept a previous version', async () => {
      const { el } = await render();
      expect(el.querySelector('.rollback')).toBeNull();
      api.list.mockResolvedValue([withUpdate({ previousSha: PREVIOUS })]);
      const second = await render();
      expect(second.el.querySelector('.rollback')).toBeNull();
      api.list.mockResolvedValue([{ ...withUpdate({ previousSha: PREVIOUS }), canRollback: true }]);
      const third = await render();
      expect(third.el.querySelector('.rollback')?.textContent).toContain(
        'Voltar para a Versão Anterior',
      );
    });

    it('confirms inline naming the previous version, then asks the API', async () => {
      api.list.mockResolvedValue([{ ...withUpdate({ previousSha: PREVIOUS }), canRollback: true }]);
      const { fixture, el, button } = await render();
      button('Voltar para a Versão Anterior').click();
      fixture.detectChanges();
      expect(el.textContent).toContain('para a versão anterior (0a1b2c3)');
      expect(api.maintain).not.toHaveBeenCalled();
      el.querySelector<HTMLButtonElement>('.maintenance-confirm')!.click();
      await vi.waitFor(() => {
        fixture.detectChanges();
        expect(el.querySelector('.message')?.textContent).toContain('volta para a versão anterior');
      });
      expect(api.maintain).toHaveBeenCalledWith('a1', 'rollback');
    });

    it('explains a computer that kept no previous version', async () => {
      api.maintain.mockRejectedValueOnce(
        new HttpErrorResponse({
          status: 409,
          error: { type: 'https://uniover.app/problems/no-previous-version' },
        }),
      );
      api.list.mockResolvedValue([{ ...withUpdate({ previousSha: PREVIOUS }), canRollback: true }]);
      const { fixture, el, button } = await render();
      button('Voltar para a Versão Anterior').click();
      fixture.detectChanges();
      el.querySelector<HTMLButtonElement>('.maintenance-confirm')!.click();
      await vi.waitFor(() => {
        fixture.detectChanges();
        expect(el.querySelector('.message')?.textContent).toContain(
          'não guardou uma versão anterior',
        );
      });
    });

    it('keeps the button off for a disconnected agent', async () => {
      api.list.mockResolvedValue([
        { ...withUpdate({ previousSha: PREVIOUS }), canRollback: true, connected: false },
      ]);
      const { button } = await render();
      expect(button('Voltar para a Versão Anterior').disabled).toBe(true);
    });
  });

  it('opens the log sheet for a connected agent that can read its log', async () => {
    const { fixture, el, button } = await render();
    button('Ver Registro').click();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(el.querySelector('app-agent-log-sheet pre')?.textContent).toBe('linha 1\nlinha 2');
    });
    expect(api.logs).toHaveBeenCalledExactlyOnceWith('a1');
    expect(el.querySelector('app-agent-log-sheet h2')?.textContent).toBe('Registro de PC de casa');
  });

  it('tells an old agent to update instead of asking the API', async () => {
    api.list.mockResolvedValue([{ ...PC, canReadLogs: false, canMaintain: false }]);
    const { fixture, el, button } = await render();
    button('Ver Registro').click();
    fixture.detectChanges();
    expect(el.querySelector('app-agent-log-sheet')).toBeNull();
    expect(api.logs).not.toHaveBeenCalled();
    expect(el.querySelector('.message')?.textContent).toContain('Atualize o agente');
    button('Atualizar Agora').click();
    fixture.detectChanges();
    expect(api.maintain).not.toHaveBeenCalled();
    expect(el.querySelector('.maintenance-confirm')).toBeNull();
  });

  it('confirms inline before updating, then asks the API and says what happens next', async () => {
    const { fixture, el, button } = await render();
    button('Atualizar Agora').click();
    fixture.detectChanges();
    expect(el.textContent).toContain('Atualizar o agente de PC de casa agora?');
    expect(api.maintain).not.toHaveBeenCalled();
    el.querySelector<HTMLButtonElement>('.maintenance-confirm')!.click();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(el.querySelector('.message')?.textContent).toContain('Pedido de atualização enviado');
    });
    expect(api.maintain).toHaveBeenCalledExactlyOnceWith('a1', 'update');
    expect(el.querySelector('.maintenance-confirm')).toBeNull();
  });

  it('can cancel the restart without asking anything', async () => {
    const { fixture, el, button } = await render();
    button('Reiniciar o Agente').click();
    fixture.detectChanges();
    expect(el.textContent).toContain('Reiniciar o agente de PC de casa?');
    button('Cancelar').click();
    fixture.detectChanges();
    expect(api.maintain).not.toHaveBeenCalled();
    expect(el.querySelector('.maintenance-confirm')).toBeNull();
    expect(button('Reiniciar o Agente')).toBeDefined();
  });

  it('restarts after the confirmation and reports a refusal of the passkey', async () => {
    api.maintain.mockRejectedValueOnce(
      new HttpErrorResponse({
        status: 403,
        error: {
          type: 'https://uniover.app/problems/step-up-required',
          code: 'step_up_required',
          action: 'devices.agent-maintenance',
        },
      }),
    );
    const { fixture, el, button } = await render();
    button('Reiniciar o Agente').click();
    fixture.detectChanges();
    el.querySelector<HTMLButtonElement>('.maintenance-confirm')!.click();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(el.querySelector('.message')?.textContent).toContain(
        'A ação não foi confirmada com a passkey. Nada foi feito.',
      );
    });
    expect(api.maintain).toHaveBeenCalledWith('a1', 'restart');
  });

  it.each([
    ['agent-offline', 'O agente está desconectado'],
    ['agent-timeout', 'O agente não respondeu a tempo'],
    ['agent-outdated', 'Atualize o agente'],
  ])('explains a %s answer in plain words', async (kind, text) => {
    api.maintain.mockRejectedValueOnce(
      new HttpErrorResponse({
        status: 503,
        error: { type: `https://uniover.app/problems/${kind}` },
      }),
    );
    const { fixture, el, button } = await render();
    button('Reiniciar o Agente').click();
    fixture.detectChanges();
    el.querySelector<HTMLButtonElement>('.maintenance-confirm')!.click();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(el.querySelector('.message')?.textContent).toContain(text);
    });
  });

  it('keeps the maintenance buttons off for a disconnected agent and without a network', async () => {
    api.list.mockResolvedValue([{ ...PC, connected: false }]);
    const { fixture, el, button } = await render();
    expect(button('Ver Registro').disabled).toBe(true);
    expect(button('Atualizar Agora').disabled).toBe(true);
    expect(button('Reiniciar o Agente').disabled).toBe(true);
    expect(button('Revogar').disabled).toBe(false);
    api.list.mockResolvedValue([PC]);
    TestBed.inject(ConnectivityService).online.set(false);
    fixture.detectChanges();
    expect(button('Revogar').disabled).toBe(true);
    expect(el.textContent).toContain('Sem conexão');
  });

  it('explains the empty state', async () => {
    api.list.mockResolvedValue([]);
    const { el } = await render();
    expect(el.textContent).toContain(
      'Nenhum aparelho pareado. Rode o agente no PC e digite o código que ele mostrar.',
    );
  });

  it('offers a retry when the list cannot be loaded', async () => {
    api.list.mockRejectedValueOnce(new HttpErrorResponse({ status: 0 }));
    const { fixture, el, button } = await render();
    expect(el.textContent).toContain('Não foi possível carregar os aparelhos');
    button('Tentar de novo').click();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(el.querySelector('.name')?.textContent).toBe('PC de casa');
  });

  it('opens the pairing sheet and, after approving, shows the message and reloads the list', async () => {
    const { fixture, el, button } = await render();
    button('Parear Aparelho').click();
    await fixture.whenStable();
    fixture.detectChanges();
    const code = el.querySelector<HTMLInputElement>('#pair-code')!;
    code.value = 'bcdf2345';
    code.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    api.list.mockResolvedValue([PC, { ...PC, id: 'a2', name: 'Notebook' }]);
    button('Aprovar').click();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(el.querySelectorAll('.item')).toHaveLength(2);
    });
    expect(el.querySelector('app-pair-sheet')).toBeNull();
    expect(el.querySelector('.message')?.textContent).toContain('Aparelho PC de casa pareado.');
  });

  it('confirms inline before revoking and marks the item as revoked', async () => {
    const { fixture, el, button } = await render();
    button('Revogar').click();
    fixture.detectChanges();
    expect(el.textContent).toContain('Revogar o PC de casa? Ele para de receber comandos na hora.');
    expect(api.revoke).not.toHaveBeenCalled();
    el.querySelector<HTMLButtonElement>('.danger')!.click();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(el.querySelector('.chip.revoked')).not.toBeNull();
    });
    expect(api.revoke).toHaveBeenCalledExactlyOnceWith('a1');
    expect(el.textContent).toContain('Aparelho revogado.');
    expect(el.querySelector('.item .actions')).toBeNull();
  });

  it('keeps the item when revoking fails and says so', async () => {
    api.revoke.mockRejectedValue(new HttpErrorResponse({ status: 500 }));
    const { fixture, el, button } = await render();
    button('Revogar').click();
    fixture.detectChanges();
    el.querySelector<HTMLButtonElement>('.danger')!.click();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(el.textContent).toContain('Não foi possível revogar agora.');
    });
    expect(el.querySelector('.chip.active')).not.toBeNull();
  });

  it('disables pairing and revoking without a network, with an explanation', async () => {
    const { fixture, el, button } = await render();
    TestBed.inject(ConnectivityService).online.set(false);
    fixture.detectChanges();
    expect(button('Parear Aparelho').disabled).toBe(true);
    expect(button('Revogar').disabled).toBe(true);
    expect(el.textContent).toContain('Sem conexão: parear, recusar e revogar precisam de rede.');
  });

  describe('alerts and organization', () => {
    it('shows an unseen outage and dismisses it with "Entendi"', async () => {
      api.alerts.mockResolvedValue([
        {
          id: 'o1',
          agentId: 'a1',
          agentName: 'PC de casa',
          detectedAt: '2026-10-27T12:00:00Z',
          lastSeenAt: '2026-10-27T11:50:00Z',
          recoveredAt: null,
        },
      ]);
      const { fixture, el, button } = await render();
      expect(el.querySelector('.alert')?.textContent).toContain('PC de casa está sem sinal');
      expect(el.querySelector('.alert')?.classList.contains('warn')).toBe(true);
      button('Entendi').click();
      await fixture.whenStable();
      fixture.detectChanges();
      expect(api.markAlertsSeen).toHaveBeenCalledOnce();
      expect(el.querySelector('.alert')).toBeNull();
    });

    it('says when the computer is back', async () => {
      api.alerts.mockResolvedValue([
        {
          id: 'o1',
          agentId: 'a1',
          agentName: 'PC de casa',
          detectedAt: '2026-10-27T12:00:00Z',
          lastSeenAt: null,
          recoveredAt: '2026-10-27T12:20:00Z',
        },
      ]);
      const { el } = await render();
      expect(el.querySelector('.alert')?.textContent).toContain('PC de casa voltou');
      expect(el.querySelector('.alert')?.classList.contains('ok')).toBe(true);
    });

    it('keeps the list when the alerts or the TVs cannot be read', async () => {
      api.alerts.mockRejectedValue(new Error('x'));
      api.tvs.mockRejectedValue(new Error('x'));
      const { el } = await render();
      expect(el.querySelector('.alert')).toBeNull();
      expect(el.querySelector('.tv-list')).toBeNull();
      expect(el.querySelectorAll('.item')).toHaveLength(1);
    });

    it('lists the TVs with their computer and state, apart from the computers', async () => {
      api.tvs.mockResolvedValue([
        { id: 't1', name: 'TV da sala', agentSlug: PC.slug, online: true },
        { id: 't2', name: 'TV do quarto', agentSlug: null, online: false },
      ]);
      const { el } = await render();
      const rows = Array.from(el.querySelectorAll('.tv-item')).map((row) => row.textContent);
      expect(rows[0]).toContain('TV da sala');
      expect(rows[0]).toContain('Computador: PC de casa');
      expect(rows[0]).toContain('Online');
      expect(rows[1]).toContain('Sem computador');
      expect(rows[1]).toContain('Sem Conexão');
    });

    it('keeps the main actions apart from the dangerous ones', async () => {
      const { el } = await render();
      const main = Array.from(el.querySelectorAll('.actions.main button')).map((b) =>
        b.textContent?.trim(),
      );
      const danger = Array.from(el.querySelectorAll('.danger-zone button')).map((b) =>
        b.textContent?.trim(),
      );
      expect(main).toEqual(['Ver Registro', 'Atualizar Agora']);
      expect(danger).toEqual(['Reiniciar o Agente', 'Revogar']);
    });

    it('has no back link of its own: the header arrow is the only one', async () => {
      const { el } = await render();
      expect(el.querySelector('a.back')).toBeNull();
    });
  });
});

describe('DevicesPage deep link and connector', () => {
  const api = {
    list: vi.fn(),
    approve: vi.fn(),
    approveOwn: vi.fn(),
    deny: vi.fn(),
    revoke: vi.fn(),
  };
  const WINDOWS =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0 Safari/537.36';

  beforeEach(() => {
    localStorage.clear();
    api.list.mockReset().mockResolvedValue([]);
    TestBed.configureTestingModule({
      providers: [
        provideRouter([{ path: 'ajustes/dispositivos', component: DevicesPage }]),
        { provide: DevicesApi, useValue: api },
      ],
    });
  });

  afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  async function open(url: string) {
    const harness = await RouterTestingHarness.create();
    await harness.navigateByUrl(url, DevicesPage);
    await harness.fixture.whenStable();
    harness.detectChanges();
    return { harness, el: harness.routeNativeElement as HTMLElement };
  }

  it('opens the approval sheet with the code from the link, normalized, and drops it from the address', async () => {
    const { harness, el } = await open('/ajustes/dispositivos?codigo=bcdf2345');
    await vi.waitFor(() => {
      harness.detectChanges();
      expect(el.querySelector('app-pair-sheet')).not.toBeNull();
    });
    expect(el.querySelector<HTMLInputElement>('#pair-code')!.value).toBe('BCDF-2345');
    await vi.waitFor(() => expect(TestBed.inject(Router).url).toBe('/ajustes/dispositivos'));
  });

  it('keeps other parameters when it drops the code', async () => {
    await open('/ajustes/dispositivos?codigo=bcdf2345&x=1');
    await vi.waitFor(() => expect(TestBed.inject(Router).url).toBe('/ajustes/dispositivos?x=1'));
  });

  it('opens nothing when the link has no code', async () => {
    const { el } = await open('/ajustes/dispositivos');
    expect(el.querySelector('app-pair-sheet')).toBeNull();
  });

  it('does not open an empty sheet for an empty code, but still cleans the address', async () => {
    const { el } = await open('/ajustes/dispositivos?codigo=');
    await vi.waitFor(() => expect(TestBed.inject(Router).url).toBe('/ajustes/dispositivos'));
    expect(el.querySelector('app-pair-sheet')).toBeNull();
  });

  it('opens the guest sheet with the code and a suggested TV name for a guest with the TV', async () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(WINDOWS);
    TestBed.overrideProvider(AuthService, {
      useValue: { authorized: (call: (token: string) => unknown) => call('token') },
    });
    TestBed.overrideProvider(AuthApi, { useValue: { stepUpWithPassword: vi.fn() } });
    TestBed.inject(SessionState).setUser({
      id: 'guest-1',
      email: 'g@example.com',
      displayName: 'Raphael',
      role: 'guest',
      permissions: ['module:tv'],
    });
    const { harness, el } = await open('/ajustes/dispositivos?codigo=bcdf2345');
    await vi.waitFor(() => {
      harness.detectChanges();
      expect(el.querySelector('app-guest-pair-sheet')).not.toBeNull();
    });
    expect(el.querySelector('app-pair-sheet')).toBeNull();
    expect(el.querySelector<HTMLInputElement>('#guest-pair-code')!.value).toBe('BCDF-2345');
    expect(el.querySelector<HTMLInputElement>('#guest-pair-name')!.value).toBe('TV de Raphael');
    await vi.waitFor(() => expect(TestBed.inject(Router).url).toBe('/ajustes/dispositivos'));
    expect(api.list).not.toHaveBeenCalled();
  });

  it('tells a guest without the TV to ask the administrator, without sheet, list or API call', async () => {
    TestBed.inject(SessionState).setUser({
      id: 'guest-1',
      email: 'g@example.com',
      displayName: 'Convidada',
      role: 'guest',
      permissions: ['module:training'],
    });
    const { el } = await open('/ajustes/dispositivos?codigo=bcdf2345');
    await vi.waitFor(() => expect(TestBed.inject(Router).url).toBe('/ajustes/dispositivos'));
    expect(el.textContent).toContain('Peça ao administrador para aprovar.');
    expect(el.querySelector('app-pair-sheet')).toBeNull();
    expect(el.querySelector('app-guest-pair-sheet')).toBeNull();
    expect(el.querySelector('button')).toBeNull();
    expect(api.list).not.toHaveBeenCalled();
  });

  it('lets a guest with the TV download the connector on Windows and approve only his own PC', async () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(WINDOWS);
    TestBed.inject(SessionState).setUser({
      id: 'guest-1',
      email: 'g@example.com',
      displayName: 'Convidada',
      role: 'guest',
      permissions: ['module:tv'],
    });
    const { el } = await open('/ajustes/dispositivos');
    const link = el.querySelector<HTMLAnchorElement>('a.download')!;
    expect(link.textContent?.trim()).toBe('Baixar conector');
    expect(link.getAttribute('href')).toBe('/conectar/conectar-uniover.cmd');
    // Sem lista de aparelhos nem "Parear aparelho" (isso é do administrador): só a aprovação do próprio PC.
    expect(Array.from(el.querySelectorAll('button')).map((b) => b.textContent?.trim())).toEqual([
      'Aprovar este computador',
    ]);
    expect(el.textContent).not.toContain('Peça ao administrador para aprovar.');
    expect(api.list).not.toHaveBeenCalled();
  });

  it('gives a guest without the TV no download', async () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(WINDOWS);
    TestBed.inject(SessionState).setUser({
      id: 'guest-1',
      email: 'g@example.com',
      displayName: 'Convidada',
      role: 'guest',
      permissions: ['module:training'],
    });
    const { el } = await open('/ajustes/dispositivos');
    expect(el.querySelector('a.download')).toBeNull();
    expect(el.querySelector('button')).toBeNull();
    expect(el.textContent).toContain('Peça ao administrador para aprovar.');
  });

  it('offers Connect this PC only on Windows and opens its sheet', async () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(WINDOWS);
    const { harness, el } = await open('/ajustes/dispositivos');
    const find = (text: string) =>
      Array.from(el.querySelectorAll('button')).find((b) => b.textContent?.trim() === text)!;
    expect(find('Conectar Este PC').classList.contains('primary')).toBe(true);
    expect(el.textContent).not.toContain('abra esta tela nele');
    find('Conectar Este PC').click();
    harness.detectChanges();
    expect(el.querySelector('app-connect-sheet')).not.toBeNull();
    find('Fechar').click();
    harness.detectChanges();
    expect(el.querySelector('app-connect-sheet')).toBeNull();
  });

  it('on other systems hides the action and says the connector is for a Windows PC', async () => {
    const { el } = await open('/ajustes/dispositivos');
    const labels = Array.from(el.querySelectorAll('button')).map((b) => b.textContent?.trim());
    expect(labels).not.toContain('Conectar Este PC');
    expect(el.textContent).toContain('Para conectar um PC, abra esta tela nele (Windows).');
  });
});

describe('devices route', () => {
  it('renders the page lazily, inside the shell, under Configurações', async () => {
    TestBed.configureTestingModule({
      providers: [
        provideRouter(routes),
        { provide: DevicesApi, useValue: { list: () => Promise.resolve([]) } },
      ],
    });
    const harness = await RouterTestingHarness.create();
    await harness.navigateByUrl('/ajustes/dispositivos');
    const root = harness.routeNativeElement as HTMLElement;
    expect(root.matches('app-shell')).toBe(true);
    expect(root.querySelector('app-devices-page')).not.toBeNull();
    expect(root.querySelector('h1')?.textContent).toBe('Dispositivos');
  });

  it('serves the same page at the address the agent QR points to', async () => {
    TestBed.configureTestingModule({
      providers: [
        provideRouter(routes),
        { provide: DevicesApi, useValue: { list: () => Promise.resolve([]) } },
      ],
    });
    const harness = await RouterTestingHarness.create();
    await harness.navigateByUrl('/ajustes/dispositivos?codigo=bcdf2345');
    const root = harness.routeNativeElement as HTMLElement;
    expect(root.querySelector('app-devices-page')).not.toBeNull();
    await vi.waitFor(() => {
      harness.detectChanges();
      expect(root.querySelector('app-pair-sheet')).not.toBeNull();
    });
  });
});
