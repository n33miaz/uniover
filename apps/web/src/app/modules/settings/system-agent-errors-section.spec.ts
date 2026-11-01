import { TestBed } from '@angular/core/testing';
import { SessionState } from '../../core/session/session-state';
import type { AgentDiagnostics } from './agent-diagnostics';
import { SystemAgentErrorsSection } from './system-agent-errors-section';
import { SystemApi } from './system-api';

const NOW = new Date('2026-10-31T12:00:00Z').getTime();
const minutesAgo = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();

const READ: AgentDiagnostics = {
  retentionDays: 7,
  items: [
    {
      id: 'e1',
      agentId: 'a1',
      agentName: 'PC da sala',
      at: minutesAgo(5),
      kind: 'background.failed',
      severity: 'error',
      component: 'tv.session',
      detail: 'TimeoutError em session.py:watch',
      count: 3,
    },
    {
      id: 'e2',
      agentId: 'a1',
      agentName: 'PC da sala',
      at: minutesAgo(120),
      kind: 'repair.done',
      severity: 'info',
      component: null,
      detail: 'tarefa de inicialização refeita',
      count: 1,
    },
    {
      id: 'e3',
      agentId: 'a2',
      agentName: 'Notebook',
      at: minutesAgo(30),
      kind: 'coisa.nova',
      severity: 'warn',
      component: null,
      detail: 'algo que o app ainda não conhece',
      count: 1,
    },
  ],
};

describe('SystemAgentErrorsSection', () => {
  const system = { agentDiagnostics: vi.fn() };

  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    system.agentDiagnostics.mockReset().mockResolvedValue(READ);
    TestBed.configureTestingModule({ providers: [{ provide: SystemApi, useValue: system }] });
  });

  afterEach(() => {
    vi.useRealTimers();
    localStorage.clear();
  });

  function asOwner(): void {
    const session = TestBed.inject(SessionState);
    session.setToken('t', 600);
    session.setUser({ id: '1', email: 'a@b.c', displayName: 'Dono', role: 'owner' });
  }

  async function render() {
    const fixture = TestBed.createComponent(SystemAgentErrorsSection);
    await fixture.whenStable();
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  }

  it('lists each event with a friendly title, the computer, when it happened and how many times', async () => {
    asOwner();
    const page = await render();
    const rows = Array.from(page.querySelectorAll<HTMLElement>('li.event'));
    expect(rows).toHaveLength(3);
    expect(rows[0].textContent).toContain('Tarefa de fundo falhou');
    expect(rows[0].textContent).toContain('PC da sala · tv.session');
    expect(rows[0].textContent).toContain('TimeoutError em session.py:watch');
    expect(rows[0].textContent).toContain('há 5 min · 3 vezes');
    expect(rows[1].textContent).toContain('Reparo feito');
    expect(rows[1].textContent).toContain('há 2 h');
    expect(rows[1].textContent).not.toContain('vezes');
  });

  it('tells the severity in words, not only in color', async () => {
    asOwner();
    const page = await render();
    const chips = Array.from(page.querySelectorAll<HTMLElement>('li.event .chip')).map((chip) =>
      chip.textContent?.trim(),
    );
    expect(chips).toEqual(['Erro', 'Info', 'Aviso']);
  });

  it('shows an unknown kind neutrally with its raw text', async () => {
    asOwner();
    const page = await render();
    expect(page.querySelectorAll('li.event')[2].textContent).toContain('Ocorrência (coisa.nova)');
  });

  it('says there are no errors when the list is empty', async () => {
    asOwner();
    system.agentDiagnostics.mockResolvedValue({ retentionDays: 7, items: [] });
    const page = await render();
    expect(page.textContent).toContain('Nenhum erro nos últimos 7 dias.');
    expect(page.querySelector('ul.events')).toBeNull();
  });

  it('shows the loading state until the list arrives', () => {
    asOwner();
    system.agentDiagnostics.mockReturnValue(new Promise(() => undefined));
    const fixture = TestBed.createComponent(SystemAgentErrorsSection);
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).querySelector('[role="status"]')).not.toBeNull();
  });

  it('offers to try again after a failure, and the retry loads the list', async () => {
    asOwner();
    system.agentDiagnostics.mockRejectedValueOnce(new Error('rede'));
    const fixture = TestBed.createComponent(SystemAgentErrorsSection);
    await fixture.whenStable();
    fixture.detectChanges();
    const page = fixture.nativeElement as HTMLElement;
    expect(page.querySelector('[role="alert"]')?.textContent).toContain(
      'Não foi possível carregar os erros agora.',
    );
    page.querySelector<HTMLButtonElement>('button.retry')!.click();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(page.querySelectorAll('li.event')).toHaveLength(3);
    expect(system.agentDiagnostics).toHaveBeenCalledTimes(2);
  });

  it('reloads from the refresh button', async () => {
    asOwner();
    const fixture = TestBed.createComponent(SystemAgentErrorsSection);
    await fixture.whenStable();
    fixture.detectChanges();
    (fixture.nativeElement as HTMLElement)
      .querySelector<HTMLButtonElement>('.errors-head button')!
      .click();
    await fixture.whenStable();
    expect(system.agentDiagnostics).toHaveBeenCalledTimes(2);
  });

  it('does not request anything for a guest', async () => {
    const session = TestBed.inject(SessionState);
    session.setToken('t', 600);
    session.setUser({ id: '2', email: 'g@b.c', displayName: 'Convidado', role: 'guest' });
    await render();
    expect(system.agentDiagnostics).not.toHaveBeenCalled();
  });
});
