import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { modulePrefsStorageKey } from '../../core/modules/module-prefs';
import { ModuleRegistry } from '../../core/modules/module-registry';
import { TV_LIVRE_ENTRY } from '../../core/modules/tv-livre-entry.port';
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
  const release = vi.fn();
  const watch = vi.fn(() => release);
  /** A porta do TV Livre: o módulo da TV diz se a TV atual declara a capacidade, a Início só pergunta. */
  const livreAvailable = signal(false);
  const livreRefresh = vi.fn();
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
    release.mockClear();
    watch.mockClear();
    livreAvailable.set(false);
    livreRefresh.mockClear();
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        { provide: HomeStatusPort, useValue: { status, loading, watch } },
        {
          provide: TV_LIVRE_ENTRY,
          useValue: { available: livreAvailable.asReadonly(), refresh: livreRefresh },
        },
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

  it('greets by the time of day and shows the clock', async () => {
    const { el } = await render();
    expect(el.querySelector('h1')?.textContent).toBe('Bom dia');
    expect(el.querySelector('.time')?.textContent).toBe('09:30');
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
    expect(online.getAttribute('aria-label')).toBe('Agente ligado');

    status.set({ ...status(), agent: 'offline' });
    const offline = (await render()).el.querySelector<HTMLElement>('.agent-status')!;
    expect(offline.classList.contains('warn')).toBe(true);
    expect(offline.getAttribute('aria-label')).toBe('Agente desligado');

    status.set({ ...status(), agent: 'unknown', serviceDown: true });
    const unavailable = (await render()).el.querySelector<HTMLElement>('.agent-status')!;
    expect(unavailable.classList.contains('warn')).toBe(true);
    expect(unavailable.getAttribute('aria-label')).toBe('Agente sem resposta');
  });

  it('asks the status to follow the house while on screen and lets go when it leaves', async () => {
    const { fixture } = await render();
    expect(watch).toHaveBeenCalledTimes(1);
    expect(release).not.toHaveBeenCalled();
    fixture.destroy();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('keeps all modules for the owner, TV and Treino first and then the planned ones, in order', async () => {
    const { el } = await render();
    expect(titles(el)).toEqual(['TV', 'Treino', ...PLANNED]);
    expect(el.querySelectorAll('li.widget.wide')).toHaveLength(0);
  });

  describe('TV Livre card', () => {
    it('is not there when the current TV does not declare the capability', async () => {
      const { el } = await render();
      expect(el.querySelector('article[data-module="tv-livre"]')).toBeNull();
      expect(titles(el)).not.toContain('TV Livre');
    });

    it('shows up for the owner, right after Treino, and opens /tv/livre', async () => {
      livreAvailable.set(true);
      const { el } = await render();
      expect(titles(el)).toEqual(['TV', 'Treino', 'TV Livre', ...PLANNED]);
      const card = el.querySelector<HTMLElement>('article[data-module="tv-livre"]')!;
      expect(card.classList.contains('planned')).toBe(false);
      expect(card.querySelector('app-home-soon-badge')).toBeNull();
      expect(card.querySelector('app-module-app-icon')).not.toBeNull();
      const link = card.querySelector<HTMLAnchorElement>('a.card-link')!;
      expect(link.getAttribute('href')).toBe('/tv/livre');
      expect(link.getAttribute('aria-label')).toBe('TV Livre: Configurar');
    });

    it('appears and disappears as the TV in use changes', async () => {
      const { fixture, el } = await render();
      expect(el.querySelector('article[data-module="tv-livre"]')).toBeNull();
      livreAvailable.set(true);
      fixture.detectChanges();
      expect(el.querySelector('article[data-module="tv-livre"]')).not.toBeNull();
      livreAvailable.set(false);
      fixture.detectChanges();
      expect(el.querySelector('article[data-module="tv-livre"]')).toBeNull();
    });

    it('renews the list of TVs when Início opens', async () => {
      await render();
      expect(livreRefresh).toHaveBeenCalledTimes(1);
    });

    it('never shows for a guest, even when the TV supports it', async () => {
      livreAvailable.set(true);
      TestBed.inject(SessionState).setUser({
        id: ACCOUNT,
        email: 'convidado@exemplo.com',
        displayName: 'Convidado',
        role: 'guest',
        permissions: ['module:tv', 'module:training'],
      });
      const { fixture, el } = await render();
      expect(titles(el)).not.toContain('TV Livre');
      el.querySelector<HTMLButtonElement>('button.edit')!.click();
      await fixture.whenStable();
      expect(el.querySelector('app-home-edit-sheet [data-id="tv-livre"]')).toBeNull();
    });

    it('is offered in the edit sheet only when it can show', async () => {
      const { fixture, el } = await render();
      el.querySelector<HTMLButtonElement>('button.edit')!.click();
      await fixture.whenStable();
      expect(el.querySelector('app-home-edit-sheet [data-id="tv-livre"]')).toBeNull();
      expect(el.querySelectorAll('app-home-edit-sheet [data-id]')).toHaveLength(8);
    });

    it('can be turned off in the edit sheet, and then it does not show', async () => {
      livreAvailable.set(true);
      storeAll((id) => id !== 'tv-livre');
      const { fixture, el } = await render();
      expect(el.querySelector('article[data-module="tv-livre"]')).toBeNull();
      el.querySelector<HTMLButtonElement>('button.edit')!.click();
      await fixture.whenStable();
      const row = el.querySelector('app-home-edit-sheet [data-id="tv-livre"]');
      expect(row).not.toBeNull();
      expect(row?.querySelector<HTMLInputElement>('input[role="switch"]')?.checked).toBe(false);
    });
  });

  it('links only the modules that have a screen', async () => {
    const { el } = await render();
    const links = Array.from(el.querySelectorAll<HTMLAnchorElement>('article a'));
    expect(links.map((a) => a.getAttribute('href'))).toEqual(['/tv', '/treino']);
    // O nome acessível leva a ação junto do nome que se vê.
    expect(links.map((a) => a.getAttribute('aria-label'))).toEqual([
      'TV: Abrir controle',
      'Treino: Ver treino',
    ]);
    expect(el.querySelectorAll('article .card-action')).toHaveLength(0);
    expect(el.querySelector('article[data-module="tv"] app-home-soon-badge')).toBeNull();
  });

  it('shows a planned module as a dashed card: the label under the name says Em Breve, nothing to tap or focus', async () => {
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
    const { el } = await render();
    expect(el.querySelectorAll('article app-home-soon-badge')).toHaveLength(PLANNED.length);
    expect(el.querySelectorAll('article .desc')).toHaveLength(0);
    for (const label of Array.from(el.querySelectorAll('app-home-soon-badge'))) {
      expect(label.parentElement?.matches('article.card.planned')).toBe(true);
    }
    expect(el.querySelectorAll('article .card-action')).toHaveLength(0);
    expect(el.querySelectorAll('article a.card-link')).toHaveLength(2);
  });

  it('hides a module that was turned off', async () => {
    storeAll((id) => id !== 'tv');
    expect(titles((await render()).el)).toEqual(['Treino', ...PLANNED]);
  });

  it('hides a planned module that was turned off', async () => {
    storeAll((id) => id !== 'network');
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
    const { el } = await render();
    expect(titles(el)).toEqual(['Treino', 'TV', ...PLANNED]);
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
      'Agente desligado',
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
    expect(dot?.getAttribute('aria-label')).toBe('Agente desligado');
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

  it('shows a guest the released modules and the three planned cards at the end, without the owner shortcuts', async () => {
    TestBed.inject(SessionState).setUser({
      id: ACCOUNT,
      email: 'convidado@exemplo.com',
      displayName: 'Convidado',
      role: 'guest',
      permissions: ['module:training'],
    });
    const { fixture, el } = await render();
    expect(titles(el)).toEqual(['Treino', 'Controle do PC', 'Rede da Casa', 'Backup de Fotos']);
    expect(el.querySelector('.shortcuts')).toBeNull();
    expect(el.querySelector('.agent-status')).toBeNull();
    expect(el.querySelector('.grid')?.classList.contains('guest-grid')).toBe(true);
    el.querySelector<HTMLButtonElement>('button.edit')!.click();
    await fixture.whenStable();
    expect(el.querySelectorAll('app-home-edit-sheet [data-id]')).toHaveLength(4);
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
    const guest = await render();
    const guestLast = guest.el.querySelector<HTMLElement>('article[data-module="backup"]')!;
    expect(guestLast.parentElement?.classList.contains('centered-last')).toBe(true);
    expect(guestLast.classList.contains('planned')).toBe(true);
  });

  it('troca os espaços reservados pelo conteúdo sem apagar a grade já disponível', async () => {
    loading.set(true);
    const { el } = await render();
    expect(el.querySelectorAll('.hero .ui-skeleton')).toHaveLength(3);
    expect(el.querySelectorAll('article.card')).toHaveLength(8);
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
    const { el } = await render();
    const icons = Array.from(el.querySelectorAll('article app-module-app-icon.ico'));
    expect(icons).toHaveLength(8);
    const drawings = icons.map((icon) =>
      Array.from(icon.querySelectorAll('svg path'))
        .map((path) => path.getAttribute('d'))
        .join('|'),
    );
    expect(drawings.every((drawing) => drawing.length > 0)).toBe(true);
    expect(new Set(drawings).size).toBe(8);
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
    expect(titles(el)).toEqual(['TV', 'Treino', ...PLANNED]);

    await press('button.edit');
    await press('.moves .down');
    await press('.done'); // Concluir
    expect(titles(el)).toEqual(['Treino', 'TV', ...PLANNED]);
    expect(JSON.parse(localStorage.getItem(KEY)!)[0].id).toBe('training');
  });
});
