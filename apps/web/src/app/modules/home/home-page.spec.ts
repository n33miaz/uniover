import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { MODULE_PREFS_KEY, ModulePrefs } from '../../core/modules/module-prefs';
import { HomeStatus, HomeStatusPort } from '../../core/status/home-status.port';
import { ClockService } from '../../core/time/clock.service';
import { HomePage, dayPartFor, greetingFor } from './home-page';

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

  beforeEach(() => {
    localStorage.clear();
    status.set({ userName: null, agent: 'unknown', watcher: 'unknown', serviceDown: false });
    TestBed.configureTestingModule({
      providers: [provideRouter([]), { provide: HomeStatusPort, useValue: { status } }],
    });
    TestBed.inject(ClockService).now.set(new Date('2026-10-18T09:30:00'));
  });

  async function render() {
    const fixture = TestBed.createComponent(HomePage);
    await fixture.whenStable();
    return { fixture, el: fixture.nativeElement as HTMLElement };
  }
  const titles = (el: HTMLElement) =>
    Array.from(el.querySelectorAll('article h3')).map((h) => h.textContent?.trim());

  it('greets by the time of day and shows the clock', async () => {
    const { el } = await render();
    expect(el.querySelector('h1')?.textContent).toBe('Bom dia');
    expect(el.querySelector('.time')?.textContent).toBe('09:30');
    status.set({ ...status(), userName: 'Neemias' });
    TestBed.inject(ClockService).now.set(new Date('2026-10-18T20:00:00'));
    expect((await render()).el.querySelector('h1')?.textContent).toBe('Boa noite, Neemias');
  });

  it('says "no data" in the info strip while there is no real source', async () => {
    const { el } = await render();
    const chips = Array.from(el.querySelectorAll('.chips li')).map((c) => c.textContent?.trim());
    expect(chips).toEqual(['Agente sem dados', 'Vigia sem dados']);
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

  it('shows one block per module with its main action and size', async () => {
    const { el } = await render();
    expect(titles(el)).toEqual(['TV', 'Treino']);
    const links = Array.from(el.querySelectorAll<HTMLAnchorElement>('article a.action'));
    expect(links.map((a) => [a.textContent?.trim(), a.getAttribute('href')])).toEqual([
      ['Abrir controle', '/tv'],
      ['Ver treino', '/treino'],
    ]);
    const sizes = Array.from(el.querySelectorAll('li.widget')).map((li) =>
      li.classList.contains('wide'),
    );
    expect(sizes).toEqual([false, true]);
    expect(el.querySelector('.card .chip')?.textContent).toContain('Em breve');
  });

  it('lets a small block that would be alone on its row take the whole row', async () => {
    const full = (el: HTMLElement) =>
      Array.from(el.querySelectorAll('li.widget')).map((li) => li.classList.contains('full'));
    // TV pequena seguida de Treino largo: a TV ficaria sozinha na linha.
    expect(full((await render()).el)).toEqual([true, true]);
    // Duas pequenas dividem a linha (as preferências já foram lidas, então troca pelo serviço).
    TestBed.inject(ModulePrefs).apply([
      { id: 'tv', size: 'small', enabled: true },
      { id: 'training', size: 'small', enabled: true },
    ]);
    const pair = (await render()).el;
    expect(full(pair)).toEqual([false, false]);
    expect(pair.querySelectorAll('li.widget.wide')).toHaveLength(0);
  });

  it('hides a module that was turned off', async () => {
    localStorage.setItem(
      MODULE_PREFS_KEY,
      JSON.stringify([
        { id: 'tv', size: 'small', enabled: false },
        { id: 'training', size: 'wide', enabled: true },
      ]),
    );
    expect(titles((await render()).el)).toEqual(['Treino']);
  });

  it('offers shortcuts to the devices and settings screens', async () => {
    const { el } = await render();
    const links = Array.from(el.querySelectorAll<HTMLAnchorElement>('.shortcuts a.shortcut'));
    expect(links.map((a) => a.getAttribute('href'))).toEqual(['/ajustes/aparelhos', '/ajustes']);
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
    expect(online.querySelector('article[data-module="training"] .badges')?.textContent).toContain(
      'Em breve',
    );
    expect(online.querySelector('article[data-module="training"] .chip.ok')).toBeNull();

    status.set({ ...status(), agent: 'offline' });
    const offline = (await render()).el;
    expect(
      offline.querySelector('article[data-module="tv"] .badges .chip.warn')?.textContent,
    ).toContain('Sem agente em casa');
  });

  it('gives every module a one line description and a hidden-from-readers glyph', async () => {
    const { el } = await render();
    const descriptions = Array.from(el.querySelectorAll('article .desc')).map((p) =>
      p.textContent?.trim(),
    );
    expect(descriptions).toEqual(['Ligar, volume, canais e apps', 'Fichas, séries e progresso']);
    for (const svg of Array.from(el.querySelectorAll('article svg'))) {
      expect(svg.getAttribute('aria-hidden')).toBe('true');
    }
  });

  it('shows a friendly empty state when every module is hidden, and it opens the editor', async () => {
    localStorage.setItem(
      MODULE_PREFS_KEY,
      JSON.stringify([
        { id: 'tv', size: 'small', enabled: false },
        { id: 'training', size: 'wide', enabled: false },
      ]),
    );
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
    expect(titles(el)).toEqual(['TV', 'Treino']);

    await press('button.edit');
    await press('.moves .down');
    await press('.footer .primary'); // Aplicar
    expect(titles(el)).toEqual(['Treino', 'TV']);
    expect(JSON.parse(localStorage.getItem(MODULE_PREFS_KEY)!)[0].id).toBe('training');
  });
});
