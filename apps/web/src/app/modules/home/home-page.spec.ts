import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { modulePrefsStorageKey } from '../../core/modules/module-prefs';
import { ModuleRegistry } from '../../core/modules/module-registry';
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
  });
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
    status.set({ userName: null, agent: 'unknown', watcher: 'unknown', serviceDown: false });
    release.mockClear();
    watch.mockClear();
    TestBed.configureTestingModule({
      providers: [provideRouter([]), { provide: HomeStatusPort, useValue: { status, watch } }],
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
    'Saúde e eventos',
    'Monitor dos serviços',
    'Rede da casa',
    'Backup de fotos',
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

  it('says "no data" in the info strip while the status has nothing to tell', async () => {
    const { el } = await render();
    const chips = Array.from(el.querySelectorAll('.chips li')).map((c) => c.textContent?.trim());
    expect(chips).toEqual(['Agente sem dados', 'Vigia sem dados']);
  });

  it('asks the status to follow the house while on screen and lets go when it leaves', async () => {
    const { fixture } = await render();
    expect(watch).toHaveBeenCalledTimes(1);
    expect(release).not.toHaveBeenCalled();
    fixture.destroy();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('colours the strip by state and always says it in words as well', async () => {
    const strip = async (next: Partial<HomeStatus>) => {
      status.set({
        userName: null,
        agent: 'unknown',
        watcher: 'unknown',
        serviceDown: false,
        ...next,
      });
      const { el } = await render();
      return Array.from(el.querySelectorAll('.chips li')).map((chip) => [
        chip.textContent?.trim(),
        chip.classList.contains('ok') ? 'ok' : chip.classList.contains('warn') ? 'warn' : 'neutral',
        chip.querySelector('.dot')?.classList.contains('hollow') ?? false,
      ]);
    };
    expect(await strip({ agent: 'online', watcher: 'ok' })).toEqual([
      ['Agente ligado', 'ok', false],
      ['Vigia sem avisos', 'ok', false],
    ]);
    expect(await strip({ agent: 'offline' })).toEqual([
      ['Agente desligado', 'warn', false],
      ['Vigia sem dados', 'neutral', true],
    ]);
    expect(await strip({ agent: 'online', watcher: 'alert' })).toEqual([
      ['Agente ligado', 'ok', false],
      ['Vigia com aviso', 'warn', false],
    ]);
    expect(await strip({ serviceDown: true })).toEqual([
      ['Agente sem dados', 'neutral', true],
      ['Vigia sem dados', 'neutral', true],
      ['Serviço fora do ar', 'warn', false],
    ]);
  });

  it('reflects agent, watcher and service state when known', async () => {
    status.set({ userName: null, agent: 'offline', watcher: 'alert', serviceDown: true });
    const { el } = await render();
    const chips = Array.from(el.querySelectorAll('.chips li')).map((c) => c.textContent?.trim());
    expect(chips).toEqual(['Agente desligado', 'Vigia com aviso', 'Serviço fora do ar']);
    status.set({ userName: null, agent: 'online', watcher: 'ok', serviceDown: false });
    const again = Array.from((await render()).el.querySelectorAll('.chips li')).map((c) =>
      c.textContent?.trim(),
    );
    expect(again).toEqual(['Agente ligado', 'Vigia sem avisos']);
  });

  it('shows one block per module, TV and Treino first and then the planned ones, in order', async () => {
    const { el } = await render();
    expect(titles(el)).toEqual(['TV', 'Treino', ...PLANNED]);
    expect(
      Array.from(el.querySelectorAll<HTMLElement>('li.widget.wide')).map(
        (widget) => widget.querySelector('article')?.dataset['module'],
      ),
    ).toEqual(['training']);
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
    expect(
      Array.from(el.querySelectorAll('article .card-action')).map((action) =>
        action.textContent?.trim(),
      ),
    ).toEqual(['Abrir controle', 'Ver treino']);
    expect(el.querySelector('article[data-module="tv"] .chip')?.textContent ?? '').not.toContain(
      'Em breve',
    );
  });

  it('shows a planned module as a calm card: the badge says coming soon, nothing to tap or focus', async () => {
    const { el } = await render();
    const planned = Array.from(el.querySelectorAll<HTMLElement>('article.card.planned'));
    expect(planned.map((card) => card.querySelector('h3')?.textContent?.trim())).toEqual(PLANNED);
    for (const card of planned) {
      const id = card.dataset['module'];
      expect(card.querySelector('.badges .chip')?.textContent?.trim(), id).toBe('Em breve');
      // O cartão não é ação: nada que receba foco, nada que seja link ou botão, nada que aperte ao toque.
      expect(
        card.querySelector('a, button, [tabindex], [role="link"], [role="button"]'),
        id,
      ).toBeNull();
      expect(card.classList.contains('ui-press'), id).toBe(false);
    }
    // Treino já abre: sem o selo "Em breve" e com a ação do cartão levando à tela.
    const training = el.querySelector('article[data-module="training"]')!;
    expect(training.classList.contains('planned')).toBe(false);
    expect(training.querySelector('.badges')?.textContent).not.toContain('Em breve');
    expect(training.querySelector('a.card-link')?.getAttribute('href')).toBe('/treino');
  });

  it('keeps the descriptions, badges and actions aligned without adding a second control', async () => {
    const { el } = await render();
    expect(el.querySelectorAll('article .badges')).toHaveLength(8);
    expect(
      Array.from(el.querySelectorAll('article .desc')).map((description) =>
        description.textContent?.trim(),
      ),
    ).toEqual([
      'Ligar, volume, canais e apps',
      'Fichas, séries e progresso',
      'Aparelhos e linha do tempo',
      'Seus serviços na internet',
      'A rede de casa num lugar só',
      'Cópia das fotos do Android',
      'Avisos e notificações',
      'Mais adiante: controlar o PC',
    ]);
    expect(el.querySelectorAll('article .card-action')).toHaveLength(2);
    expect(el.querySelectorAll('article a.card-link')).toHaveLength(2);
  });

  it('hides a module that was turned off', async () => {
    storeAll((id) => id !== 'tv');
    expect(titles((await render()).el)).toEqual(['Treino', ...PLANNED]);
  });

  it('hides a planned module that was turned off', async () => {
    storeAll((id) => id !== 'network');
    expect(titles((await render()).el)).not.toContain('Rede da casa');
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
    ).toBe(true);
    expect(
      el.querySelector('article[data-module="tv"]')?.parentElement?.classList.contains('wide'),
    ).toBe(false);
  });

  it('offers shortcuts to the devices and settings screens', async () => {
    const { el } = await render();
    const links = Array.from(el.querySelectorAll<HTMLAnchorElement>('.shortcuts a.shortcut'));
    expect(links.map((a) => a.getAttribute('href'))).toEqual(['/ajustes/aparelhos', '/ajustes']);
    expect(el.querySelectorAll('.shortcut-hint')).toHaveLength(0);
    expect(links.map((a) => a.querySelector('.shortcut-title')?.textContent?.trim())).toEqual([
      'Aparelhos',
      'Ajustes',
    ]);
    expect(el.querySelector('.shortcuts')?.getAttribute('aria-label')).toBe('Atalhos');
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

  it('shows no live state on the TV block while the agent state is unknown', async () => {
    const { el } = await render();
    expect(el.querySelector('article[data-module="tv"] .badges')?.textContent?.trim()).toBe('');
  });

  it('reflects the agent on the TV block when it is known, and never on other modules', async () => {
    status.set({ ...status(), agent: 'online' });
    const online = (await render()).el;
    expect(
      online.querySelector('article[data-module="tv"] .badges .chip.ok')?.textContent,
    ).toContain('Pronto para usar');
    expect(
      online.querySelector('article[data-module="training"] .badges')?.textContent,
    ).not.toContain('Em breve');
    expect(online.querySelector('article[data-module="training"] .chip.ok')).toBeNull();
    expect(online.querySelector('article[data-module="health"] .chip.ok')).toBeNull();

    status.set({ ...status(), agent: 'offline' });
    const offline = (await render()).el;
    expect(
      offline.querySelector('article[data-module="tv"] .badges .chip.warn')?.textContent,
    ).toContain('Sem agente em casa');
  });

  it('hides every glyph from screen readers while keeping each module description visible', async () => {
    const { el } = await render();
    for (const svg of Array.from(el.querySelectorAll('article svg'))) {
      expect(svg.getAttribute('aria-hidden')).toBe('true');
    }
    expect(el.querySelectorAll('article .desc')).toHaveLength(8);
  });

  it('draws a glyph of its own for every module, planned ones included', async () => {
    const { el } = await render();
    const icons = Array.from(el.querySelectorAll('article .ico'));
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

  it('opens the edit sheet, and Cancelar discards while Aplicar saves', async () => {
    const { fixture, el } = await render();
    const press = async (selector: string, index = 0) => {
      el.querySelectorAll<HTMLButtonElement>(selector)[index].click();
      await fixture.whenStable();
    };

    expect(el.querySelector('app-home-edit-sheet')).toBeNull();
    await press('button.edit');
    const dialog = el.querySelector('dialog');
    expect(dialog?.hasAttribute('open')).toBe(true);
    expect(dialog?.querySelector('[aria-label="Fechar"]')).toBeNull();

    await press('.moves .down'); // desce a TV
    await press('.footer .secondary'); // Cancelar
    expect(el.querySelector('app-home-edit-sheet')).toBeNull();
    expect(titles(el)).toEqual(['TV', 'Treino', ...PLANNED]);

    await press('button.edit');
    await press('.moves .down');
    await press('.footer .primary'); // Aplicar
    expect(titles(el)).toEqual(['Treino', 'TV', ...PLANNED]);
    expect(JSON.parse(localStorage.getItem(KEY)!)[0].id).toBe('training');
  });
});
