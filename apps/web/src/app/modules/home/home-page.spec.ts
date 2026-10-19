import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { MODULE_PREFS_KEY } from '../../core/modules/module-prefs';
import { HomeStatus, HomeStatusPort } from '../../core/status/home-status.port';
import { ClockService } from '../../core/time/clock.service';
import { HomePage, greetingFor } from './home-page';

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

  it('links to the settings page', async () => {
    const { el } = await render();
    const link = el.querySelector<HTMLAnchorElement>('a.edit');
    expect(link?.textContent?.trim()).toBe('Ajustes');
    expect(link?.getAttribute('href')).toBe('/ajustes');
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
