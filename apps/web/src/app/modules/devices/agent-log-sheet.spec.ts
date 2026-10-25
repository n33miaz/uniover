import { HttpErrorResponse } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { ConnectivityService } from '../../core/connectivity/connectivity.service';
import { AgentLogSheet } from './agent-log-sheet';
import { AgentLog, DeviceAgent, DevicesApi } from './devices-api';

const AGENT: DeviceAgent = {
  id: 'a1',
  slug: 'agent:pc-de-casa',
  name: 'PC de casa',
  platform: 'windows',
  createdAt: '2026-10-18T12:00:00Z',
  revoked: false,
  lastSeenAt: null,
  connected: true,
  canReadLogs: true,
  canMaintain: true,
  canRollback: false,
};

const LOG: AgentLog = {
  text: '2026-10-24 14:00:00 INFO conectado\n2026-10-24 14:00:01 INFO pronto',
  lines: 2,
  truncated: false,
  at: '2026-10-24T14:00:02Z',
};

function problem(kind: string, status: number) {
  return new HttpErrorResponse({ status, error: { type: `https://uniover.app/problems/${kind}` } });
}

describe('AgentLogSheet', () => {
  const api = { logs: vi.fn() };

  beforeEach(() => {
    api.logs.mockReset().mockResolvedValue(LOG);
    TestBed.configureTestingModule({ providers: [{ provide: DevicesApi, useValue: api }] });
  });

  async function render() {
    const fixture = TestBed.createComponent(AgentLogSheet);
    fixture.componentRef.setInput('agent', AGENT);
    let closed = 0;
    fixture.componentInstance.closed.subscribe(() => closed++);
    await fixture.whenStable();
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    const button = (text: string) =>
      Array.from(el.querySelectorAll<HTMLButtonElement>('button')).find(
        (b) => b.textContent?.trim() === text,
      )!;
    return { fixture, el, button, closed: () => closed };
  }

  it('opens as a modal sheet titled with the device and shows the log in a monospaced block', async () => {
    const { el } = await render();
    const dialog = el.querySelector('dialog')!;
    expect(dialog.hasAttribute('open')).toBe(true);
    expect(dialog.getAttribute('aria-labelledby')).toBe('log-title');
    expect(el.querySelector('h2')?.textContent).toBe('Registro de PC de casa');
    const output = el.querySelector('pre')!;
    expect(output.textContent).toBe(LOG.text);
    expect(output.getAttribute('tabindex')).toBe('0');
    expect(output.getAttribute('aria-label')).toBe('Registro do agente');
    expect(el.textContent).toContain('2 linhas, as mais recentes.');
    expect(api.logs).toHaveBeenCalledExactlyOnceWith('a1');
  });

  it('says so when the agent cut the oldest lines to fit', async () => {
    api.logs.mockResolvedValue({ ...LOG, truncated: true });
    const { el } = await render();
    expect(el.textContent).toContain('Só o fim coube no limite do canal.');
  });

  it('shows an empty log in words and keeps copy off', async () => {
    api.logs.mockResolvedValue({ text: '', lines: 0, truncated: false, at: 'x' });
    const { el, button } = await render();
    expect(el.textContent).toContain('O registro está vazio.');
    expect(el.querySelector('pre')).toBeNull();
    expect(button('Copiar').disabled).toBe(true);
  });

  it('copies the whole text to the clipboard and confirms', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    const { fixture, el, button } = await render();
    button('Copiar').click();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(el.textContent).toContain('Copiado.');
    });
    expect(writeText).toHaveBeenCalledExactlyOnceWith(LOG.text);
    vi.unstubAllGlobals();
  });

  it('says how to copy by hand when the clipboard refuses', async () => {
    vi.stubGlobal('navigator', {
      ...navigator,
      clipboard: { writeText: vi.fn().mockRejectedValue(new Error('negado')) },
    });
    const { fixture, el, button } = await render();
    button('Copiar').click();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(el.textContent).toContain('Não foi possível copiar.');
    });
    vi.unstubAllGlobals();
  });

  it('asks again on Atualizar and shows the new text', async () => {
    const { fixture, el, button } = await render();
    api.logs.mockResolvedValue({ ...LOG, text: 'só uma linha nova', lines: 1 });
    button('Atualizar').click();
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(el.querySelector('pre')?.textContent).toBe('só uma linha nova');
    });
    expect(api.logs).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['agent-outdated', 409, 'Atualize o agente neste computador'],
    ['agent-offline', 503, 'O agente está desconectado'],
    ['agent-timeout', 504, 'O agente não respondeu a tempo'],
    ['logs-in-progress', 409, 'Já há um pedido de registro em andamento'],
    ['command-failed', 502, 'O agente não conseguiu ler o registro agora'],
    ['logs-missing', 502, 'O agente não conseguiu ler o registro agora'],
    ['internal-error', 500, 'Não foi possível ver o registro agora'],
  ])('explains %s in plain words and keeps no text on screen', async (kind, status, text) => {
    api.logs.mockRejectedValue(problem(kind, status));
    const { el, button } = await render();
    expect(el.querySelector('[role="alert"]')?.textContent).toContain(text);
    expect(el.querySelector('pre')).toBeNull();
    expect(button('Copiar').disabled).toBe(true);
  });

  it('explains a lost connection and a rate limit', async () => {
    api.logs.mockRejectedValue(new HttpErrorResponse({ status: 0 }));
    const first = await render();
    expect(first.el.querySelector('[role="alert"]')?.textContent).toContain(
      'Sem conexão com o servidor',
    );
    api.logs.mockRejectedValue(new HttpErrorResponse({ status: 429 }));
    const second = await render();
    expect(second.el.querySelector('[role="alert"]')?.textContent).toContain(
      'Muitos pedidos seguidos',
    );
  });

  it('disables refreshing without a network', async () => {
    const { fixture, button } = await render();
    TestBed.inject(ConnectivityService).online.set(false);
    fixture.detectChanges();
    expect(button('Atualizar').disabled).toBe(true);
  });

  it('asks the page to take it away once when the user closes it', async () => {
    const { button, closed } = await render();
    button('Fechar').click();
    button('Fechar').click();
    expect(closed()).toBe(1);
  });
});
