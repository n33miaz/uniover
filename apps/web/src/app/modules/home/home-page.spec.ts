import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { ModulePrefs, modulePrefsStorageKey } from '../../core/modules/module-prefs';
import { ModuleRegistry } from '../../core/modules/module-registry';
import { PcAvailability, PcStatus } from '../../core/modules/pc-availability';
import { SessionState } from '../../core/session/session-state';
import { HomeStatus, HomeStatusPort } from '../../core/status/home-status.port';
import { ClockService } from '../../core/time/clock.service';
import { HomePage, dayPartFor, firstNameOf, greetingFor } from './home-page';

describe('firstNameOf', () => {
  it.each([
    ['Neemias Cormino Manso', 'Neemias'],
    ['  Ana   Paula ', 'Ana'],
    ['Raphael', 'Raphael'],
    ['', null],
    ['   ', null],
    [null, null],
  ])('%j gives %j', (name, expected) => expect(firstNameOf(name)).toBe(expected));
});

describe('greetingFor', () => {
  it.each([
    [5, 'Bom dia'],
    [11, 'Bom dia'],
    [12, 'Boa tarde'],
    [17, 'Boa tarde'],
    [18, 'Boa noite'],
    [3, 'Boa noite'],
  ])('at %i o clock says %s', (hour, expected) => expect(greetingFor(hour)).toBe(expected));
});

describe('dayPartFor', () => {
  it.each([
    [4, 'evening'],
    [5, 'morning'],
    [11, 'morning'],
    [12, 'afternoon'],
    [17, 'afternoon'],
    [18, 'evening'],
  ])('at %i o clock is %s', (hour, expected) => expect(dayPartFor(hour)).toBe(expected));
});

describe('HomePage', () => {
  const status = signal<HomeStatus>({
    userName: null,
    agent: 'unknown',
    watcher: 'unknown',
    serviceDown: false,
    agentLinked: null,
  });
  const loading = signal(false);
  /**
   * O estado do PC é o da API: aqui um dublê, para o cartão do Controle do PC ser provado em todos os estados. `null` é "a API
   * ainda não respondeu".
   */
  const pcStatus = signal<PcStatus | null>(null);
  const setPc = (available: boolean | null) =>
    pcStatus.set(
      available === null
        ? null
        : { available, online: available, apps: [], capabilities: [], volume: null },
    );
  const pcRefresh = vi.fn(() => Promise.resolve(true));
  const release = vi.fn();
  const watch = vi.fn(() => release);
  /** A escolha da Início é guardada por conta: a do dono que usa a tela nestes testes. */
  const ACCOUNT = 'conta-dono';
  const KEY = modulePrefsStorageKey(ACCOUNT);

  afterEach(() => {
    // A conta identificada deixa dicas no armazenamento, que os outros arquivos de teste dividem.
    localStorage.clear();
  });

  beforeEach(() => {
    localStorage.clear();
    status.set({
      userName: null,
      agent: 'unknown',
      watcher: 'unknown',
      serviceDown: false,
      agentLinked: null,
    });
    loading.set(false);
    // Por padrão a casa já respondeu que não tem computador com o controle ligado.
    setPc(false);
    pcRefresh.mockClear();
    release.mockClear();
    watch.mockClear();
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        { provide: HomeStatusPort, useValue: { status, loading, watch } },
        { provide: PcAvailability, useValue: { status: pcStatus, refresh: pcRefresh } },
      ],
    });
    TestBed.inject(ClockService).now.set(new Date('2026-10-18T09:30:00'));
    TestBed.inject(SessionState).setUser({
      id: ACCOUNT,
      email: 'dono@exemplo.com',
      displayName: 'Dono',
      role: 'owner',
    });
  });

  async function render() {
    const fixture = TestBed.createComponent(HomePage);
    await fixture.whenStable();
    return { fixture, el: fixture.nativeElement as HTMLElement };
  }
  const titles = (el: HTMLElement) =>
    Array.from(el.querySelectorAll('article h3')).map((h) => h.textContent?.trim());
  const PLANNED = [
    'Saúde e Eventos',
    'Monitor dos Serviços',
    'Rede da Casa',
    'Backup de Fotos',
    'Avisos',
    'Controle do PC',
  ];
  const WORKING = ['TV', 'Treino', 'Compras'];
  /** O administrador libera estes "em breve" para a Início (por padrão nenhum aparece). */
  const showSoon = (
    ids: readonly string[] = ['health', 'monitor', 'network', 'backup', 'notifications', 'pc'],
  ) => TestBed.inject(ModulePrefs).soonVisible.set(ids);
  /** Preferência guardada com todos os módulos do catálogo, ligados ou desligados, na ordem do catálogo. */
  const storeAll = (enabled: (id: string) => boolean) =>
    localStorage.setItem(
      KEY,
      JSON.stringify(
        TestBed.inject(ModuleRegistry).modules.map((m) => ({
          id: m.id,
          size: m.defaultSize,
          enabled: enabled(m.id),
        })),
      ),
    );

  it('greets by the time of day without the clock', async () => {
    const { el } = await render();
    expect(el.querySelector('h1')?.textContent).toBe('Bom dia');
    expect(el.querySelector('.time')).toBeNull();
    status.set({ ...status(), userName: 'Neemias Cormino Manso' });
    TestBed.inject(ClockService).now.set(new Date('2026-10-18T20:00:00'));
    expect((await render()).el.querySelector('h1')?.textContent).toBe('Boa noite, Neemias');
  });

  it('shows the current agent state in the accessible indicator only when there is a state', async () => {
    const { el } = await render();
    expect(el.querySelector('.chips')).toBeNull();
    expect(el.querySelector('.agent-status')).toBeNull();

    status.set({ ...status(), agent: 'online' });
    const online = (await render()).el.querySelector<HTMLElement>('.agent-status')!;
    expect(online.classList.contains('ok')).toBe(true);
    expect(online.getAttribute('aria-label')).toBe('Computador ligado');

    status.set({ ...status(), agent: 'offline' });
    const offline = (await render()).el.querySelector<HTMLElement>('.agent-status')!;
    expect(offline.classList.contains('warn')).toBe(true);
    expect(offline.getAttribute('aria-label')).toBe('Computador desligado');

    status.set({ ...status(), agent: 'unknown', serviceDown: true });
    const unavailable = (await render()).el.querySelector<HTMLElement>('.agent-status')!;
    expect(unavailable.classList.contains('warn')).toBe(true);
    expect(unavailable.getAttribute('aria-label')).toBe('Computador sem resposta');
  });

  it('asks the status to follow the house while on screen and lets go when it leaves', async () => {
    const { fixture } = await render();
    expect(watch).toHaveBeenCalledTimes(1);
    expect(release).not.toHaveBeenCalled();
    fixture.destroy();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('shows only the working modules by default: the "em breve" ones stay hidden until the admin releases them', async () => {
    const { el } = await render();
    expect(titles(el)).toEqual(WORKING);
    expect(el.querySelectorAll('li.widget.wide')).toHaveLength(0);
    expect(el.querySelectorAll('app-home-soon-badge')).toHaveLength(0);
  });

  it('shows the released "em breve" modules after the working ones, in order', async () => {
    showSoon();
    const { el } = await render();
    expect(titles(el)).toEqual([...WORKING, ...PLANNED]);
  });

  it('shows only the "em breve" modules the admin released', async () => {
    showSoon(['backup', 'health']);
    const { el } = await render();
    expect(titles(el)).toEqual([...WORKING, 'Saúde e Eventos', 'Backup de Fotos']);
  });

  it('puts the working modules first even when a saved order put a planned one on top', async () => {
    localStorage.setItem(
      KEY,
      JSON.stringify([
        { id: 'health', size: 'small', enabled: true },
        { id: 'training', size: 'small', enabled: true },
        { id: 'tv', size: 'small', enabled: true },
      ]),
    );
    showSoon(['health']);
    const { el } = await render();
    expect(titles(el)).toEqual(['Treino', 'TV', 'Compras', 'Saúde e Eventos']);
  });

  it('never lets the edit sheet show or switch on a "em breve" module the admin did not release', async () => {
    const { fixture, el } = await render();
    el.querySelector<HTMLButtonElement>('button.edit')!.click();
    await fixture.whenStable();
    expect(
      Array.from(el.querySelectorAll('app-home-edit-sheet [data-id]')).map((row) =>
        row.getAttribute('data-id'),
      ),
    ).toEqual(['tv', 'training', 'shopping']);
  });

  it('does not show TV Livre in the grid or editor, even with an old saved preference', async () => {
    localStorage.setItem(KEY, JSON.stringify([{ id: 'tv-livre', size: 'small', enabled: true }]));
    const { fixture, el } = await render();
    expect(el.querySelector('article[data-module="tv-livre"]')).toBeNull();
    el.querySelector<HTMLButtonElement>('button.edit')!.click();
    await fixture.whenStable();
    expect(el.querySelector('app-home-edit-sheet [data-id="tv-livre"]')).toBeNull();
    expect(el.querySelectorAll('app-home-edit-sheet [data-id]')).toHaveLength(3);
  });

  it('links only the modules that have a screen', async () => {
    const { el } = await render();
    const links = Array.from(el.querySelectorAll<HTMLAnchorElement>('article a'));
    expect(links.map((a) => a.getAttribute('href'))).toEqual(['/tv', '/treino', '/compras']);
    // O nome acessível leva a ação junto do nome que se vê.
    expect(links.map((a) => a.getAttribute('aria-label'))).toEqual([
      'TV: Abrir controle',
      'Treino: Ver treino',
      'Compras: Abrir compras',
    ]);
    expect(el.querySelectorAll('article .card-action')).toHaveLength(0);
    expect(el.querySelector('article[data-module="tv"] app-home-soon-badge')).toBeNull();
  });

  it('shows a planned module as a dashed card: the label under the name says Em Breve, nothing to tap or focus', async () => {
    showSoon();
    const { el } = await render();
    const planned = Array.from(el.querySelectorAll<HTMLElement>('article.card.planned'));
    expect(planned.map((card) => card.querySelector('h3')?.textContent?.trim())).toEqual(PLANNED);
    for (const card of planned) {
      const id = card.dataset['module'];
      expect(card.querySelector('app-home-soon-badge')?.textContent?.trim(), id).toBe('Em Breve');
      // O rótulo vem logo depois do nome, dentro do cartão; não há mais selo no canto.
      expect(card.querySelector('h3 + app-home-soon-badge'), id).not.toBeNull();
      expect(card.querySelector('.badges'), id).toBeNull();
      // O cartão não é ação: nada que receba foco, nada que seja link ou botão, nada que aperte ao toque.
      expect(
        card.querySelector('a, button, [tabindex], [role="link"], [role="button"]'),
        id,
      ).toBeNull();
      expect(card.classList.contains('ui-press'), id).toBe(false);
    }
    // Treino já abre: sem o rótulo "Em Breve" e com a ação do cartão levando à tela.
    const training = el.querySelector('article[data-module="training"]')!;
    expect(training.classList.contains('planned')).toBe(false);
    expect(training.querySelector('app-home-soon-badge')).toBeNull();
    expect(training.querySelector('a.card-link')?.getAttribute('href')).toBe('/treino');
  });

  it('removes descriptions and keeps the Em Breve label inside its card without adding a second control', async () => {
    showSoon();
    const { el } = await render();
    expect(el.querySelectorAll('article app-home-soon-badge')).toHaveLength(PLANNED.length);
    expect(el.querySelectorAll('article .desc')).toHaveLength(0);
    for (const label of Array.from(el.querySelectorAll('app-home-soon-badge'))) {
      expect(label.parentElement?.matches('article.card.planned')).toBe(true);
    }
    expect(el.querySelectorAll('article .card-action')).toHaveLength(0);
    expect(el.querySelectorAll('article a.card-link')).toHaveLength(3);
  });

  it('hides a module that was turned off', async () => {
    storeAll((id) => id !== 'tv');
    showSoon();
    expect(titles((await render()).el)).toEqual(['Treino', 'Compras', ...PLANNED]);
  });

  it('hides a planned module that was turned off', async () => {
    storeAll((id) => id !== 'network');
    showSoon();
    expect(titles((await render()).el)).not.toContain('Rede da Casa');
  });

  it('still reads a preference saved before the planned modules existed', async () => {
    // Só TV e Treino, como um aparelho antigo guardou: os planejados entram no fim, ligados.
    localStorage.setItem(
      KEY,
      JSON.stringify([
        { id: 'training', size: 'wide', enabled: true },
        { id: 'tv', size: 'small', enabled: true },
      ]),
    );
    showSoon();
    const { el } = await render();
    expect(titles(el)).toEqual(['Treino', 'TV', 'Compras', ...PLANNED]);
    expect(
      el
        .querySelector('article[data-module="training"]')
        ?.parentElement?.classList.contains('wide'),
    ).toBe(false);
    expect(
      el.querySelector('article[data-module="tv"]')?.parentElement?.classList.contains('wide'),
    ).toBe(false);
  });

  it('shows only the state dot of the agent, never a badge about another computer', async () => {
    status.set({
      userName: null,
      agent: 'offline',
      watcher: 'unknown',
      serviceDown: false,
      agentLinked: true,
    });
    const { el } = await render();
    expect(el.querySelector('.agent-alert')).toBeNull();
    expect(el.querySelector<HTMLElement>('.agent-status')?.getAttribute('aria-label')).toBe(
      'Computador desligado',
    );
  });

  it('shows no dot at all when the account has no agent linked', async () => {
    status.set({
      userName: null,
      agent: 'unknown',
      watcher: 'unknown',
      serviceDown: false,
      agentLinked: false,
    });
    const { el } = await render();
    expect(el.querySelector('.agent-status')).toBeNull();
  });

  it('pulses the dot while the state is still being read, and stops once it is known', async () => {
    status.set({
      userName: null,
      agent: 'unknown',
      watcher: 'unknown',
      serviceDown: false,
      agentLinked: null,
    });
    loading.set(true);
    const { el, fixture } = await render();
    expect(el.querySelector('.agent-status.connecting')).not.toBeNull();
    loading.set(false);
    status.set({
      userName: null,
      agent: 'online',
      watcher: 'unknown',
      serviceDown: false,
      agentLinked: true,
    });
    fixture.detectChanges();
    expect(el.querySelector('.agent-status.connecting')).toBeNull();
    expect(el.querySelector('.agent-status.ok')).not.toBeNull();
  });

  it('centers the brand in its own top bar and puts Configurações beside it', async () => {
    const { el } = await render();
    const topbar = el.querySelector<HTMLElement>('.home-topbar')!;
    const brand = topbar.querySelector<HTMLElement>('.brand')!;
    expect(brand.textContent?.trim()).toBe('UniOver');
    expect(brand.parentElement).toBe(topbar);
    expect(topbar.querySelector('.agent-slot')).not.toBeNull();
    expect(el.querySelector<HTMLAnchorElement>('.hero-settings')?.getAttribute('href')).toBe(
      '/ajustes',
    );
    expect(el.querySelector('.hero-settings')?.getAttribute('aria-label')).toBe('Configurações');
    expect(el.querySelector('.shortcuts')).toBeNull();
  });

  it('draws a different scene for each part of the day behind the greeting', async () => {
    const scene = async (hour: number) => {
      TestBed.inject(ClockService).now.set(
        new Date(`2026-10-18T${String(hour).padStart(2, '0')}:00:00`),
      );
      const { el } = await render();
      return Array.from(el.querySelectorAll('.hero app-home-glyph.scene path'))
        .map((path) => path.getAttribute('d'))
        .join('|');
    };
    const drawings = [await scene(9), await scene(14), await scene(21)];
    expect(drawings.every((drawing) => drawing.length > 0)).toBe(true);
    expect(new Set(drawings).size).toBe(3);
  });

  it('does not put a live state on the TV card', async () => {
    const { el } = await render();
    expect(el.querySelector('article[data-module="tv"]')?.textContent?.trim()).toBe('TV');
  });

  it('keeps Configurações no cartão também para convidado', async () => {
    TestBed.inject(SessionState).setUser({
      id: ACCOUNT,
      email: 'convidado@exemplo.com',
      displayName: 'Convidado',
      role: 'guest',
      permissions: ['module:tv'],
    });
    const { el } = await render();
    expect(el.querySelector<HTMLAnchorElement>('.hero-settings')?.getAttribute('href')).toBe(
      '/ajustes',
    );
    expect(el.querySelector('.shortcuts')).toBeNull();
  });

  it('mostra ao convidado com a TV a bolinha do agente dele, e nada sobre computadores de outras pessoas', async () => {
    TestBed.inject(SessionState).setUser({
      id: ACCOUNT,
      email: 'convidado@exemplo.com',
      displayName: 'Convidado',
      role: 'guest',
      permissions: ['module:tv'],
    });
    status.set({
      userName: null,
      agent: 'offline',
      watcher: 'unknown',
      serviceDown: false,
      agentLinked: true,
    });
    const { el } = await render();
    const dot = el.querySelector('.agent-status');
    expect(dot?.getAttribute('aria-label')).toBe('Computador desligado');
    expect(el.querySelector('.agent-alert')).toBeNull();
    expect(el.querySelector('.hero-settings')).not.toBeNull();
  });

  it('não mostra a bolinha do agente ao convidado sem a TV', async () => {
    TestBed.inject(SessionState).setUser({
      id: ACCOUNT,
      email: 'convidado@exemplo.com',
      displayName: 'Convidado',
      role: 'guest',
      permissions: ['module:training'],
    });
    status.set({
      userName: null,
      agent: 'online',
      watcher: 'unknown',
      serviceDown: false,
      agentLinked: true,
    });
    const { el } = await render();
    expect(el.querySelector('.agent-status')).toBeNull();
    expect(el.querySelector('.agent-alert')).toBeNull();
  });

  it('shows a guest only the released modules by default, and the "em breve" ones the admin chose after them', async () => {
    TestBed.inject(SessionState).setUser({
      id: ACCOUNT,
      email: 'convidado@exemplo.com',
      displayName: 'Convidado',
      role: 'guest',
      permissions: ['module:training'],
    });
    const { fixture, el } = await render();
    expect(titles(el)).toEqual(['Treino']);
    expect(el.querySelector('.shortcuts')).toBeNull();
    expect(el.querySelector('.agent-status')).toBeNull();
    expect(el.querySelector('.grid')?.classList.contains('guest-grid')).toBe(true);
    showSoon(['pc', 'network', 'backup']);
    await fixture.whenStable();
    expect(titles(el)).toEqual(['Treino', 'Rede da Casa', 'Backup de Fotos', 'Controle do PC']);
    el.querySelector<HTMLButtonElement>('button.edit')!.click();
    await fixture.whenStable();
    expect(el.querySelectorAll('app-home-edit-sheet [data-id]')).toHaveLength(4);
  });

  it('shows the Compras card only to a guest who has its permission', async () => {
    TestBed.inject(SessionState).setUser({
      id: ACCOUNT,
      email: 'convidado@exemplo.com',
      displayName: 'Convidado',
      role: 'guest',
      permissions: ['module:shopping'],
    });
    const { el } = await render();
    expect(titles(el)).toContain('Compras');
    expect(titles(el)).not.toContain('Treino');
    expect(
      el.querySelector('article[data-module="shopping"] a.card-link')?.getAttribute('href'),
    ).toBe('/compras');
  });

  it('marca o último cartão ímpar, em uso ou Em breve, para centralizar', async () => {
    storeAll((id) => id === 'tv');
    const owner = await render();
    const ownerLast = owner.el.querySelector<HTMLElement>('article[data-module="tv"]')!;
    expect(ownerLast.parentElement?.classList.contains('centered-last')).toBe(true);
    expect(ownerLast.classList.contains('planned')).toBe(false);

    TestBed.inject(SessionState).setUser({
      id: 'conta-convidado',
      email: 'convidado@exemplo.com',
      displayName: 'Convidado',
      role: 'guest',
      permissions: [],
    });
    showSoon(['pc', 'network', 'backup']);
    const guest = await render();
    const guestLast = guest.el.querySelector<HTMLElement>('article[data-module="pc"]')!;
    expect(guestLast.parentElement?.classList.contains('centered-last')).toBe(true);
    expect(guestLast.classList.contains('planned')).toBe(true);
  });

  it('troca os espaços reservados pelo conteúdo sem apagar a grade já disponível', async () => {
    loading.set(true);
    const { el } = await render();
    expect(el.querySelectorAll('.hero .ui-skeleton')).toHaveLength(2);
    expect(el.querySelectorAll('article.card')).toHaveLength(3);
    loading.set(false);
    expect((await render()).el.querySelectorAll('.hero .ui-skeleton')).toHaveLength(0);
  });

  it('hides every module icon from screen readers without rendering descriptions', async () => {
    const { el } = await render();
    for (const svg of Array.from(el.querySelectorAll('article svg'))) {
      expect(svg.getAttribute('aria-hidden')).toBe('true');
    }
    expect(el.querySelectorAll('article .desc')).toHaveLength(0);
  });

  it('draws an app icon of its own for every module, planned ones included', async () => {
    showSoon();
    const { el } = await render();
    const icons = Array.from(el.querySelectorAll('article app-module-app-icon.ico'));
    expect(icons).toHaveLength(9);
    const drawings = icons.map((icon) =>
      Array.from(icon.querySelectorAll('svg path'))
        .map((path) => path.getAttribute('d'))
        .join('|'),
    );
    expect(drawings.every((drawing) => drawing.length > 0)).toBe(true);
    expect(new Set(drawings).size).toBe(9);
  });

  it('shows a friendly empty state when every module is hidden, and it opens the editor', async () => {
    storeAll(() => false);
    const { fixture, el } = await render();
    expect(el.querySelectorAll('article.card')).toHaveLength(0);
    expect(el.querySelector('.empty')?.textContent).toContain('Nenhum módulo na Início');
    el.querySelector<HTMLButtonElement>('.empty-action')!.click();
    await fixture.whenStable();
    expect(el.querySelector('dialog')?.hasAttribute('open')).toBe(true);
  });

  it('opens the edit sheet, where Esc discards and Concluir saves', async () => {
    const { fixture, el } = await render();
    const press = async (selector: string, index = 0) => {
      el.querySelectorAll<HTMLButtonElement>(selector)[index].click();
      await fixture.whenStable();
    };

    expect(el.querySelector('app-home-edit-sheet')).toBeNull();
    await press('button.edit');
    const sheet = el.querySelector<HTMLDialogElement>('dialog')!;
    expect(sheet.hasAttribute('open')).toBe(true);
    expect(sheet.querySelector('.done')?.textContent?.trim()).toBe('Concluir');

    await press('.moves .down'); // desce a TV
    sheet.dispatchEvent(new Event('cancel', { cancelable: true }));
    await fixture.whenStable();
    expect(el.querySelector('app-home-edit-sheet')).toBeNull();
    expect(titles(el)).toEqual(WORKING);

    await press('button.edit');
    await press('.moves .down');
    await press('.done'); // Concluir
    expect(titles(el)).toEqual(['Treino', 'TV', 'Compras']);
    expect(JSON.parse(localStorage.getItem(KEY)!)[0].id).toBe('training');
  });

  describe('the PC control card', () => {
    const card = (el: HTMLElement) => el.querySelector<HTMLElement>('article[data-module="pc"]')!;
    const refresh = pcRefresh;
    const memory = (account: string) => `uniover.home.pc.v1.${account}`;

    it('asks the API whether the house has a PC with the control on when the owner opens the Início', async () => {
      await render();
      expect(refresh).toHaveBeenCalledTimes(1);
    });

    it('stays out of the grid when the house has no PC, and is a planned card only if the admin released it', async () => {
      const { el } = await render();
      expect(card(el)).toBeNull();
      showSoon(['pc']);
      const released = await render();
      expect(card(released.el).classList.contains('planned')).toBe(true);
      expect(card(released.el).querySelector('app-home-soon-badge')?.textContent?.trim()).toBe(
        'Em Breve',
      );
      expect(card(released.el).querySelector('a')).toBeNull();
    });

    it('does not draw the card at all (neither active nor planned) while nothing is known, even if released', async () => {
      setPc(null);
      showSoon(['pc']);
      // A leitura segue em andamento (servidor acordando): nem resposta, nem falha.
      pcRefresh.mockImplementationOnce(() => new Promise<boolean>(() => undefined));
      const { el } = await render();
      expect(card(el)).toBeNull();
      expect(titles(el)).toEqual(WORKING);
    });

    it('draws the card as it is from the first render when this account remembers the last answer', async () => {
      setPc(null);
      pcRefresh.mockImplementationOnce(() => new Promise<boolean>(() => undefined));
      localStorage.setItem(memory(ACCOUNT), 'yes');
      const { el } = await render();
      expect(card(el).classList.contains('planned')).toBe(false);
      expect(card(el).querySelector('app-home-soon-badge')).toBeNull();
      expect(card(el).querySelector('a.card-link')?.getAttribute('href')).toBe('/pc');
      // O cartão ativo entra junto dos que funcionam, antes de qualquer "em breve".
      expect(titles(el)).toEqual([...WORKING, 'Controle do PC']);
    });

    it('never shows the card as planned between the remembered "yes" and the API answer', async () => {
      setPc(null);
      showSoon(['pc']);
      localStorage.setItem(memory(ACCOUNT), 'yes');
      pcRefresh.mockImplementationOnce(() => new Promise<boolean>(() => undefined));
      const { fixture, el } = await render();
      const looks = [card(el).className];
      setPc(true);
      await fixture.whenStable();
      looks.push(card(el).className);
      for (const look of looks) expect(look).not.toContain('planned');
    });

    it('lets the API answer win over what was remembered', async () => {
      localStorage.setItem(memory(ACCOUNT), 'yes');
      setPc(false);
      showSoon(['pc']);
      const { el } = await render();
      expect(card(el).classList.contains('planned')).toBe(true);
    });

    it('remembers the answer once the API gives it, per account', async () => {
      setPc(null);
      pcRefresh.mockImplementationOnce(() => {
        setPc(true);
        return Promise.resolve(true);
      });
      await render();
      expect(localStorage.getItem(memory(ACCOUNT))).toBe('yes');
      expect(localStorage.getItem(memory('outra-conta'))).toBeNull();
    });

    it('falls back to "em breve" when the first read ends without an answer and nothing was remembered (no computer is invented)', async () => {
      setPc(null);
      showSoon(['pc']);
      pcRefresh.mockImplementationOnce(() => Promise.resolve(false));
      const { el } = await render();
      expect(card(el).classList.contains('planned')).toBe(true);
      expect(card(el).querySelector('a')).toBeNull();
      expect(localStorage.getItem(memory(ACCOUNT))).toBeNull();
    });

    it('keeps the remembered "yes" when the read ends without an answer', async () => {
      setPc(null);
      localStorage.setItem(memory(ACCOUNT), 'yes');
      pcRefresh.mockImplementationOnce(() => Promise.resolve(false));
      const { el } = await render();
      expect(card(el).querySelector('a.card-link')?.getAttribute('href')).toBe('/pc');
      expect(localStorage.getItem(memory(ACCOUNT))).toBe('yes');
    });

    it('stops being "Em Breve" and opens the module once a PC with the control is known', async () => {
      setPc(true);
      const { el } = await render();
      expect(card(el).classList.contains('planned')).toBe(false);
      expect(card(el).querySelector('app-home-soon-badge')).toBeNull();
      const link = card(el).querySelector('a.card-link')!;
      expect(link.getAttribute('href')).toBe('/pc');
      expect(link.getAttribute('aria-label')).toBe('Controle do PC: Abrir controle');
    });

    it('follows the PC as it appears while the screen is open', async () => {
      const { fixture, el } = await render();
      expect(card(el)).toBeNull();
      setPc(true);
      await fixture.whenStable();
      expect(card(el).querySelector('a.card-link')?.getAttribute('href')).toBe('/pc');
    });

    it('does not ask a guest who cannot use the module, forgets what it remembered, and keeps the planned card for them', async () => {
      localStorage.setItem(memory('guest'), 'yes');
      showSoon(['pc']);
      TestBed.inject(SessionState).setUser({
        id: 'guest',
        email: 'g@exemplo.com',
        displayName: 'Raphael',
        role: 'guest',
        permissions: ['module:training'],
      });
      const { el } = await render();
      expect(refresh).not.toHaveBeenCalled();
      expect(card(el).classList.contains('planned')).toBe(true);
      expect(localStorage.getItem(memory('guest'))).toBeNull();
    });

    it('lets a guest who was granted the module use it, and hides the open module from one who was not', async () => {
      setPc(true);
      TestBed.inject(SessionState).setUser({
        id: 'guest',
        email: 'g@exemplo.com',
        displayName: 'Raphael',
        role: 'guest',
        permissions: ['module:pc'],
      });
      const granted = await render();
      expect(refresh).toHaveBeenCalledTimes(1);
      expect(card(granted.el).querySelector('a.card-link')?.getAttribute('href')).toBe('/pc');
      granted.fixture.destroy();

      TestBed.inject(SessionState).setUser({
        id: 'guest',
        email: 'g@exemplo.com',
        displayName: 'Raphael',
        role: 'guest',
        permissions: ['module:training'],
      });
      const refused = await render();
      // Mesmo que o estado diga "disponível", o módulo aberto só aparece a quem tem a permissão.
      expect(card(refused.el)).toBeNull();
    });
  });
});
