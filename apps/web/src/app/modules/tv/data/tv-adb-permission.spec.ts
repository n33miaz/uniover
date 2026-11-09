import { HttpErrorResponse } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import {
  ADB_CLEARED_MS,
  ADB_CONFIRM_POLL_MS,
  ADB_CONFIRM_TRIES,
  ADB_DISMISSED_KEY,
  ADB_DISMISS_MS,
  ADB_DONE_MS,
  ADB_WAIT_MS,
  ADB_WAIT_POLL_MS,
  TvAdbPermission,
} from './tv-adb-permission';
import { SessionState } from '../../../core/session/session-state';
import { TvApi } from './tv-api';
import type { TvState } from './tv-types';
import { HOT } from '../tv-test-kit';

const PROBLEM = 'https://uniover.app/problems/';

function failure(status: number, kind: string, extra: Record<string, unknown> = {}) {
  return new HttpErrorResponse({
    status,
    error: { type: PROBLEM + kind, title: kind, status, ...extra },
  });
}

const unauthorized = () => failure(502, 'command-failed', { agentError: 'adb_unauthorized' });
/** Tempo que a conferência do aviso leva até desistir (a primeira leitura é imediata). */
const CONFIRM_TOTAL_MS = ADB_CONFIRM_POLL_MS * (ADB_CONFIRM_TRIES - 1);

describe('TvAdbPermission', () => {
  let permission: TvAdbPermission;
  let api: {
    refreshShortcuts: ReturnType<typeof vi.fn<() => Promise<void>>>;
    rebindAdb: ReturnType<typeof vi.fn<() => Promise<void>>>;
    state: ReturnType<typeof vi.fn<() => Promise<TvState>>>;
  };

  /** O que o agente conta no estado que a tela lê. */
  const agentSays = (adbPermission: TvState['adbPermission'], reason: string | null = null) =>
    api.state.mockResolvedValue({ ...HOT, adbPermission, adbPermissionReason: reason });

  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    api = {
      refreshShortcuts: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
      rebindAdb: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
      state: vi.fn<() => Promise<TvState>>().mockResolvedValue(HOT),
    };
    TestBed.configureTestingModule({ providers: [{ provide: TvApi, useValue: api }] });
    permission = TestBed.inject(TvAdbPermission);
    permission.attach(); // a tela do controle hospeda a folha
  });

  afterEach(() => {
    permission.detach();
    localStorage.clear();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('when an ADB action is refused for lack of permission', () => {
    it('opens the sheet once and marks the shortcuts as needing it', () => {
      expect(permission.denied()).toBe(true);
      expect(permission.sheetOpen()).toBe(true);
      expect(permission.phase()).toBe('intro');
      expect(permission.needs()).toBe(true);
      // Outro toque enquanto a folha está aberta não a reabre nem mostra o erro por cima.
      expect(permission.denied()).toBe(true);
    });

    it('does not nag after "Agora não": only the short error and the quiet sign on the shortcuts', () => {
      permission.denied();
      permission.dismiss();
      expect(permission.sheetOpen()).toBe(false);
      expect(permission.needs()).toBe(true);
      expect(permission.denied()).toBe(false); // quem chamou mostra o aviso curto
      expect(permission.sheetOpen()).toBe(false);
      permission.observe('missing', 'tv_forgot'); // nem o estado "falta" a reabre
      expect(permission.sheetOpen()).toBe(false);
    });

    it('remembers "Agora não" on this device for 24 h, and then asks again', () => {
      permission.denied();
      permission.dismiss();
      expect(Object.keys(JSON.parse(localStorage.getItem(ADB_DISMISSED_KEY)!))).toHaveLength(1);
      // Outra abertura do app (a classe nasce de novo): o silêncio vale.
      TestBed.resetTestingModule();
      TestBed.configureTestingModule({ providers: [{ provide: TvApi, useValue: api }] });
      const reopened = TestBed.inject(TvAdbPermission);
      reopened.attach();
      expect(reopened.denied()).toBe(false);
      vi.setSystemTime(Date.now() + ADB_DISMISS_MS - 1000);
      expect(reopened.denied()).toBe(false);
      vi.setSystemTime(Date.now() + 2000);
      expect(reopened.denied()).toBe(true);
      reopened.detach();
    });

    it('survives an unreadable storage', () => {
      localStorage.setItem(ADB_DISMISSED_KEY, 'isto não é json');
      expect(permission.denied()).toBe(true);
      permission.dismiss(); // regrava por cima do lixo
      expect(permission.denied()).toBe(false);
    });

    it('never opens behind a modal panel that already blocks the screen', () => {
      const dialog = document.createElement('dialog');
      vi.spyOn(document, 'querySelector').mockImplementation((selector: string) =>
        selector.startsWith('dialog') ? dialog : null,
      );
      expect(permission.denied()).toBe(false);
      expect(permission.sheetOpen()).toBe(false);
      expect(permission.needs()).toBe(true);
    });
  });

  describe('when the agent tells the state', () => {
    it('opens the sheet by itself only when the TV forgot a permission it had given', () => {
      permission.observe('missing', 'tv_forgot');
      expect(permission.sheetOpen()).toBe(true);
    });

    it('never opens it by itself for a TV that was never released, or for any other reason', () => {
      for (const reason of ['never', 'tv_refused', 'unproven', 'key_changed', 'address_changed']) {
        permission.observe('missing', reason);
        expect(permission.sheetOpen(), reason).toBe(false);
        expect(permission.needs(), reason).toBe(true); // mas a falta fica à vista nos atalhos
      }
      permission.observe('missing');
      permission.observe('missing', null);
      expect(permission.sheetOpen()).toBe(false);
    });

    it('closes everything on "granted"', () => {
      permission.observe('missing', 'tv_forgot');
      permission.observe('granted');
      expect(permission.sheetOpen()).toBe(false);
      expect(permission.needs()).toBe(false);
    });

    it('does nothing for an agent that says nothing', () => {
      permission.observe(null);
      permission.observe(undefined);
      expect(permission.sheetOpen()).toBe(false);
      expect(permission.needs()).toBe(false);
      expect(permission.waiting()).toBe(false);
    });

    it('shows the notice whenever the prompt is on the TV, even if the phone did not ask', () => {
      permission.observe('pending');
      expect(permission.waiting()).toBe(true);
      expect(permission.sheetOpen()).toBe(false);
    });
  });

  describe('Pedir na TV', () => {
    it('asks with the same request as Atualizar lista and shows the notice only once the agent says "pending"', async () => {
      permission.denied();
      api.refreshShortcuts.mockRejectedValueOnce(unauthorized());
      agentSays('pending');
      await permission.ask();
      await vi.advanceTimersByTimeAsync(0);
      expect(api.refreshShortcuts).toHaveBeenCalledTimes(1);
      expect(permission.sheetOpen()).toBe(false);
      expect(permission.waiting()).toBe(true);
    });

    it('without "pending" there is no notice: the sheet says the TV showed nothing', async () => {
      permission.denied();
      api.refreshShortcuts.mockRejectedValueOnce(unauthorized());
      agentSays('missing', 'tv_refused');
      await permission.ask();
      // Enquanto confere, a folha segue "pedindo", sem recado.
      expect(permission.waiting()).toBe(false);
      expect(permission.phase()).toBe('asking');
      await vi.advanceTimersByTimeAsync(CONFIRM_TOTAL_MS + 10);
      expect(permission.waiting()).toBe(false);
      expect(permission.sheetOpen()).toBe(true);
      expect(permission.phase()).toBe('noprompt');
      expect(api.state).toHaveBeenCalledTimes(ADB_CONFIRM_TRIES);
    });

    it('a "pending" that shows up during the check wins, and no "forgot" sheet interferes', async () => {
      api.refreshShortcuts.mockRejectedValueOnce(unauthorized());
      agentSays('missing', 'tv_forgot'); // o que havia antes do pedido
      await permission.ask();
      expect(permission.phase()).toBe('asking'); // um `missing` antigo não reabre nada por cima
      agentSays('pending');
      await vi.advanceTimersByTimeAsync(ADB_CONFIRM_POLL_MS + 10);
      expect(permission.waiting()).toBe(true);
      expect(permission.sheetOpen()).toBe(false);
    });

    it('an agent that does not tell the state keeps the notice, as before the field existed', async () => {
      api.refreshShortcuts.mockRejectedValueOnce(unauthorized());
      await permission.ask(); // o estado lido não traz `adbPermission`
      await vi.advanceTimersByTimeAsync(0);
      expect(permission.waiting()).toBe(true);
    });

    it('survives a state that cannot be read while checking', async () => {
      api.refreshShortcuts.mockRejectedValueOnce(unauthorized());
      api.state.mockRejectedValue(new Error('sem rede'));
      await permission.ask();
      await vi.advanceTimersByTimeAsync(CONFIRM_TOTAL_MS + 10);
      expect(permission.phase()).toBe('noprompt');
    });

    it('proves the permission once after the accept, with one more list request', async () => {
      api.refreshShortcuts.mockRejectedValueOnce(unauthorized());
      agentSays('pending');
      await permission.ask();
      await vi.advanceTimersByTimeAsync(0);
      permission.observe('granted');
      await vi.advanceTimersByTimeAsync(0);
      expect(permission.waiting()).toBe(false);
      expect(permission.done()).toBe(true);
      expect(permission.needs()).toBe(false);
      expect(api.refreshShortcuts).toHaveBeenCalledTimes(2); // o pedido e a prova
      permission.observe('granted');
      await vi.advanceTimersByTimeAsync(0);
      expect(api.refreshShortcuts).toHaveBeenCalledTimes(2); // nenhuma prova a mais
      await vi.advanceTimersByTimeAsync(ADB_DONE_MS);
      expect(permission.done()).toBe(false);
    });

    it('a prompt that another device asked for is never followed by a proof from this one', async () => {
      permission.observe('pending');
      permission.observe('granted');
      await vi.advanceTimersByTimeAsync(0);
      expect(api.refreshShortcuts).not.toHaveBeenCalled();
    });

    it('a proof only runs after a tap on this device: expiring, dismissing or leaving disarms it', async () => {
      api.refreshShortcuts.mockRejectedValue(unauthorized());
      agentSays('pending');
      await permission.ask();
      await vi.advanceTimersByTimeAsync(0);
      permission.observe('missing', 'prompt_expired'); // ninguém aceitou: acabou
      permission.dismiss();
      expect(api.refreshShortcuts).toHaveBeenCalledTimes(1);
      // O aviso seguinte é de outro aparelho: aceitar nele não gera prova daqui.
      permission.observe('pending');
      permission.observe('granted');
      await vi.advanceTimersByTimeAsync(0);
      expect(api.refreshShortcuts).toHaveBeenCalledTimes(1);
    });

    it('needs no waiting when the TV already trusted the computer', async () => {
      permission.denied();
      await permission.ask();
      expect(permission.waiting()).toBe(false);
      expect(permission.sheetOpen()).toBe(false);
      expect(permission.needs()).toBe(false);
      expect(permission.done()).toBe(true);
    });

    it('tells an unreachable TV, another device at the address and any other failure apart', async () => {
      permission.denied();
      api.refreshShortcuts.mockRejectedValueOnce(failure(503, 'agent-offline'));
      await permission.ask();
      expect(permission.phase()).toBe('unreachable');
      expect(permission.sheetOpen()).toBe(true);
      api.refreshShortcuts.mockRejectedValueOnce(
        failure(502, 'command-failed', { agentError: 'adb_device_changed' }),
      );
      await permission.ask();
      expect(permission.phase()).toBe('notfound');
      api.refreshShortcuts.mockRejectedValueOnce(failure(500, 'boom'));
      await permission.ask();
      expect(permission.phase()).toBe('failed');
      expect(permission.sheetOpen()).toBe(true);
    });

    it('ignores a second tap while it is asking', async () => {
      permission.denied();
      let finish: () => void = () => undefined;
      api.refreshShortcuts.mockReturnValueOnce(new Promise<void>((resolve) => (finish = resolve)));
      const first = permission.ask();
      void permission.ask();
      expect(permission.asking()).toBe(true);
      expect(api.refreshShortcuts).toHaveBeenCalledTimes(1);
      finish();
      await first;
    });
  });

  describe('waiting for the accept', () => {
    beforeEach(async () => {
      api.refreshShortcuts.mockRejectedValueOnce(unauthorized());
      agentSays('pending');
      await permission.ask();
      await vi.advanceTimersByTimeAsync(0);
    });

    it('"missing" after the prompt was seen means nobody accepted: the sheet comes back saying so', () => {
      permission.observe('pending');
      permission.observe('missing', 'prompt_expired');
      expect(permission.waiting()).toBe(false);
      expect(permission.sheetOpen()).toBe(true);
      expect(permission.phase()).toBe('expired');
    });

    it('ends by itself a little after the 90 s the agent waits', async () => {
      agentSays(null);
      await vi.advanceTimersByTimeAsync(ADB_WAIT_MS + 1);
      expect(permission.waiting()).toBe(false);
      expect(permission.phase()).toBe('expired');
      expect(permission.sheetOpen()).toBe(true);
    });

    it('reads the state by itself while the stream is not running (TV Livre)', async () => {
      agentSays('granted');
      await vi.advanceTimersByTimeAsync(ADB_WAIT_POLL_MS + 1);
      expect(permission.waiting()).toBe(false);
      expect(permission.done()).toBe(true);
    });

    it('survives a failed poll', async () => {
      api.state.mockRejectedValue(new Error('sem rede'));
      await vi.advanceTimersByTimeAsync(ADB_WAIT_POLL_MS + 1);
      expect(permission.waiting()).toBe(true);
    });
  });

  it('the state "pending" may arrive before the answer of the request: the wait is not restarted', async () => {
    permission.denied();
    let fail: (error: unknown) => void = () => undefined;
    api.refreshShortcuts.mockReturnValueOnce(new Promise<void>((_, reject) => (fail = reject)));
    const asking = permission.ask();
    permission.observe('pending'); // o fluxo foi mais rápido que a resposta
    fail(unauthorized());
    await asking;
    expect(permission.waiting()).toBe(true);
    permission.observe('missing', 'prompt_expired'); // e o fim do aviso ainda é visto como "ninguém aceitou"
    expect(permission.waiting()).toBe(false);
    expect(permission.phase()).toBe('expired');
  });

  describe('prompted() by the request of the person (Atualizar lista, TV Livre)', () => {
    it('checks the agent first: with "pending" the notice shows and the proof is armed', async () => {
      agentSays('pending');
      expect(permission.prompted()).toBe(true);
      await vi.advanceTimersByTimeAsync(0);
      expect(permission.waiting()).toBe(true);
      expect(permission.sheetOpen()).toBe(false);
      permission.observe('granted');
      await vi.advanceTimersByTimeAsync(0);
      expect(api.refreshShortcuts).toHaveBeenCalledTimes(1); // a prova
    });

    it('without "pending" the sheet says nothing was shown on the TV', async () => {
      agentSays('granted');
      permission.prompted();
      // `granted` já fecha tudo: a TV aceitou. O caso de "não mostrou" é o `missing`.
      await vi.advanceTimersByTimeAsync(0);
      expect(permission.needs()).toBe(false);
      agentSays('missing', 'tv_refused');
      permission.prompted();
      await vi.advanceTimersByTimeAsync(CONFIRM_TOTAL_MS + 10);
      expect(permission.phase()).toBe('noprompt');
      expect(permission.waiting()).toBe(false);
    });

    it('with no sheet possible (a panel blocks the screen) the caller shows the short error', async () => {
      agentSays('missing', 'tv_refused');
      const dialog = document.createElement('dialog');
      vi.spyOn(document, 'querySelector').mockImplementation((selector: string) =>
        selector.startsWith('dialog') ? dialog : null,
      );
      const onUnconfirmed = vi.fn();
      permission.prompted(onUnconfirmed);
      await vi.advanceTimersByTimeAsync(CONFIRM_TOTAL_MS + 10);
      expect(onUnconfirmed).toHaveBeenCalledTimes(1);
      expect(permission.sheetOpen()).toBe(false);
    });
  });

  describe('without a screen that hosts the sheet', () => {
    it('shows nothing and lets the caller show the short error', () => {
      permission.detach();
      expect(permission.denied()).toBe(false);
      expect(permission.prompted()).toBe(false);
      expect(permission.sheetOpen()).toBe(false);
      expect(permission.waiting()).toBe(false);
      expect(permission.needs()).toBe(true); // a falta continua anotada
    });

    it('leaving the screen clears the sheet, the notice and the timers', async () => {
      agentSays('pending');
      permission.prompted();
      await vi.advanceTimersByTimeAsync(0);
      permission.detach();
      expect(permission.waiting()).toBe(false);
      expect(permission.sheetOpen()).toBe(false);
    });
  });

  it('a denial behind a modal panel opens the sheet when the panel closes', () => {
    const dialog = document.createElement('dialog');
    const lookup = vi
      .spyOn(document, 'querySelector')
      .mockImplementation((selector: string) => (selector.startsWith('dialog') ? dialog : null));
    expect(permission.denied()).toBe(false); // quem chamou mostra o erro curto
    permission.modalClosed();
    expect(permission.sheetOpen()).toBe(false); // o painel ainda está aberto
    lookup.mockImplementation(() => null);
    permission.modalClosed();
    expect(permission.sheetOpen()).toBe(true);
    permission.modalClosed(); // um segundo aviso de fechamento não faz nada
    expect(permission.phase()).toBe('intro');
  });

  it('a "Agora não" before the panel closed keeps the sheet away', () => {
    const dialog = document.createElement('dialog');
    const lookup = vi
      .spyOn(document, 'querySelector')
      .mockImplementation((selector: string) => (selector.startsWith('dialog') ? dialog : null));
    permission.denied();
    permission.dismiss();
    lookup.mockImplementation(() => null);
    permission.modalClosed();
    expect(permission.sheetOpen()).toBe(false);
  });

  describe('another device at the address of the TV ("É a mesma TV")', () => {
    it('opens the sheet saying the TV was not found, once, and respects "Agora não"', () => {
      expect(permission.deviceChanged()).toBe(true);
      expect(permission.sheetOpen()).toBe(true);
      expect(permission.phase()).toBe('notfound');
      expect(permission.needs()).toBe(true);
      permission.dismiss();
      expect(permission.deviceChanged()).toBe(false);
    });

    it('with no screen hosting it, or behind a panel, the caller shows the short error', () => {
      const dialog = document.createElement('dialog');
      const lookup = vi
        .spyOn(document, 'querySelector')
        .mockImplementation((selector: string) => (selector.startsWith('dialog') ? dialog : null));
      expect(permission.deviceChanged()).toBe(false);
      lookup.mockImplementation(() => null);
      permission.modalClosed(); // o painel fechou: a folha certa abre (a de "TV não encontrada")
      expect(permission.phase()).toBe('notfound');
      permission.detach();
      expect(permission.deviceChanged()).toBe(false);
    });

    it('asks again before anything happens: nothing is sent until "Sim, é a mesma"', () => {
      permission.deviceChanged();
      permission.askSameTv();
      expect(permission.phase()).toBe('confirmsame');
      expect(api.rebindAdb).not.toHaveBeenCalled();
      expect(api.refreshShortcuts).not.toHaveBeenCalled();
      permission.backFromSameTv();
      expect(permission.phase()).toBe('notfound');
      expect(api.rebindAdb).not.toHaveBeenCalled();
    });

    it('confirming rebinds first and only then makes the usual permission request', async () => {
      const order: string[] = [];
      api.rebindAdb.mockImplementation(async () => void order.push('rebind'));
      api.refreshShortcuts.mockImplementation(async () => void order.push('request'));
      permission.deviceChanged();
      permission.askSameTv();
      await permission.confirmSameTv();
      expect(order).toEqual(['rebind', 'request']);
      // A TV já confiava na chave: o pedido a provou, sem aviso.
      expect(permission.needs()).toBe(false);
      expect(permission.sheetOpen()).toBe(false);
    });

    it('after the rebind the prompt of the TV is followed as usual (pending, then the proof)', async () => {
      api.refreshShortcuts.mockRejectedValueOnce(unauthorized());
      agentSays('pending');
      permission.deviceChanged();
      permission.askSameTv();
      await permission.confirmSameTv();
      await vi.advanceTimersByTimeAsync(0);
      expect(permission.waiting()).toBe(true);
      permission.observe('granted');
      await vi.advanceTimersByTimeAsync(0);
      expect(api.refreshShortcuts).toHaveBeenCalledTimes(2); // o pedido e a prova
    });

    it('a failed rebind stops there: no permission request, and the sheet says why', async () => {
      permission.deviceChanged();
      permission.askSameTv();
      api.rebindAdb.mockRejectedValueOnce(
        failure(502, 'command-failed', { agentError: 'adb_identity' }),
      );
      await permission.confirmSameTv();
      expect(permission.phase()).toBe('failed');
      expect(api.refreshShortcuts).not.toHaveBeenCalled();
      api.rebindAdb.mockRejectedValueOnce(failure(503, 'agent-offline'));
      await permission.confirmSameTv();
      expect(permission.phase()).toBe('unreachable');
      api.rebindAdb.mockRejectedValueOnce(failure(409, 'adb-rebind-unsupported'));
      await permission.confirmSameTv();
      expect(permission.phase()).toBe('failed');
    });

    it('another device still there after the rebind keeps the sheet on "TV não encontrada"', async () => {
      permission.deviceChanged();
      permission.askSameTv();
      api.refreshShortcuts.mockRejectedValueOnce(
        failure(502, 'command-failed', { agentError: 'adb_device_changed' }),
      );
      await permission.confirmSameTv();
      expect(permission.phase()).toBe('notfound');
    });

    it('only the owner of the TV may redo the registration: a guest never sends it', async () => {
      TestBed.inject(SessionState).setUser({
        id: 'convidada',
        email: 'c@exemplo.com',
        displayName: 'Convidada',
        role: 'guest',
      });
      expect(permission.canRebind()).toBe(false);
      permission.deviceChanged();
      permission.askSameTv();
      expect(permission.phase()).toBe('notfound'); // nem a pergunta de confirmação abre
      await permission.confirmSameTv();
      expect(api.rebindAdb).not.toHaveBeenCalled();
      expect(api.refreshShortcuts).not.toHaveBeenCalled();
    });

    it('a second tap while it is working is ignored', async () => {
      permission.deviceChanged();
      permission.askSameTv();
      let finish: () => void = () => undefined;
      api.rebindAdb.mockReturnValueOnce(new Promise<void>((resolve) => (finish = resolve)));
      const first = permission.confirmSameTv();
      void permission.confirmSameTv();
      expect(api.rebindAdb).toHaveBeenCalledTimes(1);
      finish();
      await first;
    });
  });

  describe('when the agent deleted the registration (new pairing with another device)', () => {
    it('tells the person once with a calm notice, never silently and never with the sheet', async () => {
      permission.observe('missing', 'registration_cleared');
      expect(permission.cleared()).toBe(true);
      expect(permission.sheetOpen()).toBe(false);
      expect(permission.needs()).toBe(true);
      // O estado repete o motivo a cada mensagem: o recado não volta enquanto for o mesmo.
      await vi.advanceTimersByTimeAsync(ADB_CLEARED_MS + 1);
      expect(permission.cleared()).toBe(false);
      permission.observe('missing', 'registration_cleared');
      expect(permission.cleared()).toBe(false);
      // Outro apagar, depois de a pessoa ver outro estado, é um recado novo.
      permission.observe('missing', 'never');
      permission.observe('missing', 'registration_cleared');
      expect(permission.cleared()).toBe(true);
    });

    it('leaving the screen clears the notice', () => {
      permission.observe('missing', 'registration_cleared');
      permission.detach();
      expect(permission.cleared()).toBe(false);
    });
  });

  it('confirmed() by any ADB action that worked clears the need and the notice', async () => {
    agentSays('pending');
    permission.prompted();
    await vi.advanceTimersByTimeAsync(0);
    permission.confirmed();
    expect(permission.needs()).toBe(false);
    expect(permission.waiting()).toBe(false);
  });
});
