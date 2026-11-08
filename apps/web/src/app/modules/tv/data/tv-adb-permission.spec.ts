import { HttpErrorResponse } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { ADB_DONE_MS, ADB_WAIT_MS, ADB_WAIT_POLL_MS, TvAdbPermission } from './tv-adb-permission';
import { TvApi } from './tv-api';
import { HOT } from '../tv-test-kit';

const PROBLEM = 'https://uniover.app/problems/';

function failure(status: number, kind: string, extra: Record<string, unknown> = {}) {
  return new HttpErrorResponse({
    status,
    error: { type: PROBLEM + kind, title: kind, status, ...extra },
  });
}

const unauthorized = () => failure(502, 'command-failed', { agentError: 'adb_unauthorized' });

describe('TvAdbPermission', () => {
  let permission: TvAdbPermission;
  let api: {
    refreshShortcuts: ReturnType<typeof vi.fn<() => Promise<void>>>;
    state: ReturnType<typeof vi.fn<() => Promise<typeof HOT>>>;
  };

  beforeEach(() => {
    vi.useFakeTimers();
    api = {
      refreshShortcuts: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
      state: vi.fn<() => Promise<typeof HOT>>().mockResolvedValue(HOT),
    };
    TestBed.configureTestingModule({ providers: [{ provide: TvApi, useValue: api }] });
    permission = TestBed.inject(TvAdbPermission);
    permission.attach(); // a tela do controle hospeda a folha
  });

  afterEach(() => {
    permission.detach();
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
      permission.observe('missing'); // nem o estado "falta" a reabre
      expect(permission.sheetOpen()).toBe(false);
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
    it('opens the sheet on "missing" and closes everything on "granted"', () => {
      permission.observe('missing');
      expect(permission.sheetOpen()).toBe(true);
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
    it('asks with the same request as Atualizar lista and waits for the accept on the TV', async () => {
      permission.denied();
      api.refreshShortcuts.mockRejectedValueOnce(unauthorized());
      await permission.ask();
      expect(api.refreshShortcuts).toHaveBeenCalledTimes(1);
      expect(permission.sheetOpen()).toBe(false);
      expect(permission.waiting()).toBe(true);
    });

    it('proves the permission once after the accept, with one more list request', async () => {
      api.refreshShortcuts.mockRejectedValueOnce(unauthorized());
      await permission.ask();
      permission.observe('pending');
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

    it('needs no waiting when the TV already trusted the computer', async () => {
      permission.denied();
      await permission.ask();
      expect(permission.waiting()).toBe(false);
      expect(permission.sheetOpen()).toBe(false);
      expect(permission.needs()).toBe(false);
      expect(permission.done()).toBe(true);
    });

    it('tells an unreachable TV and any other failure apart, and lets the person try again', async () => {
      permission.denied();
      api.refreshShortcuts.mockRejectedValueOnce(failure(503, 'agent-offline'));
      await permission.ask();
      expect(permission.phase()).toBe('unreachable');
      expect(permission.sheetOpen()).toBe(true);
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
      await permission.ask();
    });

    it('a "missing" that came before the prompt is not "nobody accepted"', () => {
      permission.observe('missing');
      expect(permission.waiting()).toBe(true);
      expect(permission.sheetOpen()).toBe(false);
    });

    it('"missing" after the prompt was seen means nobody accepted: the sheet comes back saying so', () => {
      permission.observe('pending');
      permission.observe('missing');
      expect(permission.waiting()).toBe(false);
      expect(permission.sheetOpen()).toBe(true);
      expect(permission.phase()).toBe('expired');
    });

    it('ends by itself a little after the 90 s the agent waits', async () => {
      await vi.advanceTimersByTimeAsync(ADB_WAIT_MS + 1);
      expect(permission.waiting()).toBe(false);
      expect(permission.phase()).toBe('expired');
      expect(permission.sheetOpen()).toBe(true);
    });

    it('reads the state by itself while the stream is not running (TV Livre)', async () => {
      api.state.mockResolvedValue({ ...HOT, adbPermission: 'granted' });
      await vi.advanceTimersByTimeAsync(ADB_WAIT_POLL_MS + 1);
      expect(api.state).toHaveBeenCalled();
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
    permission.observe('missing'); // e o fim do aviso ainda é visto como "ninguém aceitou"
    expect(permission.waiting()).toBe(false);
    expect(permission.phase()).toBe('expired');
  });

  it('prompted() arms the proof too: Atualizar lista, once accepted, is followed by one more request', async () => {
    permission.prompted();
    permission.observe('pending');
    permission.observe('granted');
    await vi.advanceTimersByTimeAsync(0);
    expect(api.refreshShortcuts).toHaveBeenCalledTimes(1); // a prova
    expect(permission.done()).toBe(true);
    permission.observe('granted');
    await vi.advanceTimersByTimeAsync(0);
    expect(api.refreshShortcuts).toHaveBeenCalledTimes(1);
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

    it('leaving the screen clears the sheet, the notice and the timers', () => {
      permission.prompted();
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

  it('prompted() by the request of the person (Atualizar lista) starts the wait with no sheet', () => {
    permission.denied();
    permission.prompted();
    expect(permission.sheetOpen()).toBe(false);
    expect(permission.waiting()).toBe(true);
    expect(permission.needs()).toBe(true);
  });

  it('confirmed() by any ADB action that worked clears the need and the notice', () => {
    permission.prompted();
    permission.confirmed();
    expect(permission.needs()).toBe(false);
    expect(permission.waiting()).toBe(false);
  });
});
