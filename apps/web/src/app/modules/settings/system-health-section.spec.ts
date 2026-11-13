import { TestBed } from '@angular/core/testing';
import { SessionState } from '../../core/session/session-state';
import { SystemApi } from './system-api';
import { SystemHealthSection } from './system-health-section';

describe('SystemHealthSection', () => {
  const system = {
    agents: vi.fn(),
    tvs: vi.fn(),
    deploymentVersion: vi.fn(),
    deadLetters: vi.fn(),
    parity: vi.fn(),
  };

  beforeEach(() => {
    localStorage.clear();
    system.agents.mockReset().mockResolvedValue([
      {
        id: 'agent-1',
        slug: 'sala',
        name: 'PC da sala',
        platform: 'windows',
        createdAt: '2026-10-27T10:00:00Z',
        revoked: false,
        lastSeenAt: '2026-10-27T10:10:00Z',
        connected: true,
      },
    ]);
    system.tvs.mockReset().mockResolvedValue([
      {
        id: 'tv-1',
        name: 'TV da sala',
        isDefault: true,
        agentSlug: 'sala',
        kind: 'android',
        online: true,
        capabilities: [],
      },
    ]);
    system.deploymentVersion.mockReset().mockResolvedValue({ commit: 'abc1234' });
    system.deadLetters
      .mockReset()
      .mockResolvedValue({ total: 0, items: [], unavailableModules: [] });
    system.parity.mockReset().mockResolvedValue({ windowMinutes: 30, agents: [] });
    TestBed.configureTestingModule({
      providers: [{ provide: SystemApi, useValue: system }],
    });
  });

  afterEach(() => localStorage.clear());

  it('shows agent, television, API, version and failed events as five readings', async () => {
    const session = TestBed.inject(SessionState);
    session.setToken('t', 600);
    session.setUser({ id: '1', email: 'a@b.c', displayName: 'Dono', role: 'owner' });
    const fixture = TestBed.createComponent(SystemHealthSection);
    await fixture.whenStable();
    fixture.detectChanges();
    const metrics = Array.from<HTMLElement>(
      (fixture.nativeElement as HTMLElement).querySelectorAll('.metric'),
    );
    expect(metrics).toHaveLength(5);
    expect(metrics[0].textContent).toContain('Computadores');
    expect(metrics[0].textContent).toContain('Ligado');
    expect(metrics[0].textContent).toContain('PC da sala');
    expect(metrics[1].textContent).toContain('TV');
    expect(metrics[1].textContent).toContain('On-line');
    expect(metrics[1].textContent).toContain('TV da sala');
    expect(metrics[2].textContent).toContain('Serviço');
    expect(metrics[2].textContent).toContain('OK');
    expect(metrics[3].textContent).toContain('abc1234');
    expect(metrics[4].textContent).toContain('Eventos');
    expect(metrics[4].textContent).toContain('Nenhum');
  });

  it('shortens a full commit identifier to seven characters in the version reading', async () => {
    system.deploymentVersion.mockResolvedValue({
      commit: 'abcdef0123456789abcdef0123456789abcdef01',
    });
    const session = TestBed.inject(SessionState);
    session.setToken('t', 600);
    session.setUser({ id: '1', email: 'a@b.c', displayName: 'Dono', role: 'owner' });
    const fixture = TestBed.createComponent(SystemHealthSection);
    await fixture.whenStable();
    fixture.detectChanges();
    const version = (fixture.nativeElement as HTMLElement).querySelectorAll('.metric')[3];
    expect(version.querySelector('strong')?.textContent?.trim()).toBe('abcdef0');
  });

  it('lists the module versions in the order the API sends them, named in Portuguese', async () => {
    system.deploymentVersion.mockResolvedValue({
      commit: 'abc1234',
      modules: {
        identity: '0.43.0',
        devices: '0.42.15',
        tv: '0.44.2',
        training: '0.42.15',
        shopping: '0.3.1',
        web: '0.43.1',
        agent: '0.42.16',
        novo: '1.0.0',
      },
    });
    const session = TestBed.inject(SessionState);
    session.setToken('t', 600);
    session.setUser({ id: '1', email: 'a@b.c', displayName: 'Dono', role: 'owner' });
    const fixture = TestBed.createComponent(SystemHealthSection);
    await fixture.whenStable();
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;
    expect(root.querySelector('.modules-title')?.textContent?.trim()).toBe('Módulos');
    const rows = Array.from(root.querySelectorAll<HTMLElement>('.modules-list li')).map((row) =>
      Array.from(row.querySelectorAll('span')).map((cell) => cell.textContent?.trim()),
    );
    expect(rows).toEqual([
      ['Identidade', '0.43.0'],
      ['Dispositivos', '0.42.15'],
      ['TV', '0.44.2'],
      ['Treino', '0.42.15'],
      ['Compras', '0.3.1'],
      ['Site', '0.43.1'],
      ['Programa do computador', '0.42.16'],
      ['novo', '1.0.0'],
    ]);
    // Os cinco cartões de leitura continuam sendo só cinco: os módulos são uma lista à parte.
    expect(root.querySelectorAll('.metric')).toHaveLength(5);
  });

  it('omits the module list when the API does not send versions yet', async () => {
    const session = TestBed.inject(SessionState);
    session.setToken('t', 600);
    session.setUser({ id: '1', email: 'a@b.c', displayName: 'Dono', role: 'owner' });
    const fixture = TestBed.createComponent(SystemHealthSection);
    await fixture.whenStable();
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).querySelector('.modules')).toBeNull();
  });

  it('lists the events that exhausted their attempts, without the payload', async () => {
    system.deadLetters.mockResolvedValue({
      total: 3,
      items: [
        {
          module: 'tv',
          id: 'e-1',
          type: 'tv.state-changed.v1',
          failedAt: '2026-10-31T12:00:00Z',
          attempts: 8,
          lastError: 'InvalidOperationException',
        },
      ],
      unavailableModules: [],
    });
    const session = TestBed.inject(SessionState);
    session.setToken('t', 600);
    session.setUser({ id: '1', email: 'a@b.c', displayName: 'Dono', role: 'owner' });
    const fixture = TestBed.createComponent(SystemHealthSection);
    await fixture.whenStable();
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;
    const reading = root.querySelectorAll('.metric')[4];
    expect(reading.textContent).toContain('3 falhos');
    expect(reading.querySelector('strong')?.classList.contains('bad')).toBe(true);
    const list = root.querySelector('.dead');
    expect(list?.textContent).toContain('tv.state-changed.v1');
    expect(list?.textContent).toContain('InvalidOperationException');
  });

  it('keeps the rest of the health card when the failed events cannot be read', async () => {
    system.deadLetters.mockRejectedValue(new Error('boom'));
    const session = TestBed.inject(SessionState);
    session.setToken('t', 600);
    session.setUser({ id: '1', email: 'a@b.c', displayName: 'Dono', role: 'owner' });
    const fixture = TestBed.createComponent(SystemHealthSection);
    await fixture.whenStable();
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;
    expect(root.querySelector('[role="alert"]')).toBeNull();
    const metrics = root.querySelectorAll('.metric');
    expect(metrics).toHaveLength(5);
    expect(metrics[0].textContent).toContain('Ligado');
    expect(metrics[4].textContent).toContain('Leitura indisponível');
  });

  it('does not request health data for a guest', async () => {
    const session = TestBed.inject(SessionState);
    session.setToken('t', 600);
    session.setUser({ id: '1', email: 'a@b.c', displayName: 'Convidado', role: 'guest' });
    const fixture = TestBed.createComponent(SystemHealthSection);
    await fixture.whenStable();
    fixture.detectChanges();
    expect(system.agents).not.toHaveBeenCalled();
    expect(system.tvs).not.toHaveBeenCalled();
  });

  it('holds four tiles as a busy skeleton until the readings arrive', async () => {
    let finish: (agents: unknown[]) => void = () => undefined;
    system.agents.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    const session = TestBed.inject(SessionState);
    session.setToken('t', 600);
    session.setUser({ id: '1', email: 'a@b.c', displayName: 'Dono', role: 'owner' });
    const fixture = TestBed.createComponent(SystemHealthSection);
    const el = fixture.nativeElement as HTMLElement;
    await fixture.whenStable();
    fixture.detectChanges();

    expect(
      el.querySelector('app-loading-skeleton app-loading-frame[aria-busy="true"]'),
    ).not.toBeNull();
    expect(el.querySelectorAll('app-loading-skeleton .tile')).toHaveLength(4);
    expect(el.querySelector('.metric')).toBeNull();

    finish([]);
    await vi.waitFor(() => {
      fixture.detectChanges();
      expect(el.querySelector('app-loading-skeleton')).toBeNull();
    });
    expect(el.querySelectorAll('.metric')).toHaveLength(5);
  });

  async function ownerView() {
    const session = TestBed.inject(SessionState);
    session.setToken('t', 600);
    session.setUser({ id: '1', email: 'a@b.c', displayName: 'Dono', role: 'owner' });
    const fixture = TestBed.createComponent(SystemHealthSection);
    await fixture.whenStable();
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  }

  const values = (root: HTMLElement) =>
    Array.from(root.querySelectorAll('.parity-list dd')).map((dd) => dd.textContent?.trim());

  it('shows the four parity numbers of each computer, with the goal and the reference', async () => {
    system.parity.mockResolvedValue({
      windowMinutes: 30,
      agents: [
        {
          agentId: 'sala',
          directSeconds: 270,
          cloudSeconds: 30,
          directPercent: 90,
          replySamples: 40,
          replyP50Ms: 210,
          replyP95Ms: 460,
          loopLagSamples: 300,
          loopLagP99Ms: 140,
          unanswered: 2,
        },
      ],
    });
    const root = await ownerView();

    const parity = root.querySelector('.parity');
    expect(parity?.textContent).toContain('Resposta do controle · 30 min');
    expect(parity?.querySelector('.parity-name')?.textContent).toContain('PC da sala');
    expect(values(root)).toEqual(['90%', '210 ms típico · 460 ms lento', '140 ms', '2']);
    const cells = Array.from(root.querySelectorAll('.parity-list dd'));
    expect(cells[0].classList).toContain('ok');
    expect(cells[2].classList).toContain('bad');
    expect(cells[3].classList).toContain('bad');
    expect(parity?.textContent).toContain('Meta: direta 90% ou mais, atraso até 100 ms');
    expect(parity?.textContent).toContain('No Unified Remote, em casa: 5 a 20 ms');
  });

  it('shows a dash for what was not measured yet, such as the loop lag of an older computer program', async () => {
    system.parity.mockResolvedValue({
      windowMinutes: 30,
      agents: [
        {
          agentId: 'sala',
          directSeconds: 0,
          cloudSeconds: 12,
          directPercent: 0,
          replySamples: 3,
          replyP50Ms: null,
          replyP95Ms: null,
          loopLagSamples: 0,
          loopLagP99Ms: null,
          unanswered: 0,
        },
      ],
    });
    const root = await ownerView();

    expect(values(root)).toEqual(['0%', '—', '—', 'Nenhum']);
    expect(root.querySelectorAll('.parity-list dd')[3].classList).toContain('ok');
  });

  it('lists a computer with no use in the window with dashes, and keeps the card when the reading fails', async () => {
    system.parity.mockRejectedValue(new Error('boom'));
    const root = await ownerView();

    expect(root.querySelector('[role="alert"]')).toBeNull();
    expect(root.querySelectorAll('.metric')).toHaveLength(5);
    expect(values(root)).toEqual(['—', '—', '—', '—']);
  });
});
