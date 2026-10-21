import { TestBed } from '@angular/core/testing';
import { TvShortcut } from '../data/tv-types';
import { makeShortcut, pngIcon } from '../tv-test-kit';
import { AppsTile, TileMove } from './apps-tile';

describe('AppsTile', () => {
  let fixture: ReturnType<typeof TestBed.createComponent<AppsTile>>;
  let root: HTMLElement;
  let launched: ReturnType<typeof vi.fn<(shortcut: TvShortcut) => void>>;
  let toggled: ReturnType<typeof vi.fn<(shortcut: TvShortcut) => void>>;
  let renamed: ReturnType<typeof vi.fn<(shortcut: TvShortcut) => void>>;

  const show = (shortcut: TvShortcut, inputs: Record<string, unknown> = {}) => {
    fixture = TestBed.createComponent(AppsTile);
    fixture.componentRef.setInput('shortcut', shortcut);
    for (const [name, value] of Object.entries(inputs)) fixture.componentRef.setInput(name, value);
    launched = vi.fn<(shortcut: TvShortcut) => void>();
    toggled = vi.fn<(shortcut: TvShortcut) => void>();
    renamed = vi.fn<(shortcut: TvShortcut) => void>();
    fixture.componentInstance.launch.subscribe(launched);
    fixture.componentInstance.pin.subscribe(toggled);
    fixture.componentInstance.rename.subscribe(renamed);
    fixture.detectChanges();
    root = fixture.nativeElement;
  };
  const update = (inputs: Record<string, unknown>) => {
    for (const [name, value] of Object.entries(inputs)) fixture.componentRef.setInput(name, value);
    fixture.detectChanges();
  };
  const launch = () => root.querySelector<HTMLButtonElement>('.launch')!;
  const pin = () => root.querySelector<HTMLButtonElement>('.tool.pin')!;

  describe('to open the app', () => {
    it('is one button: the icon on top and the name under it, named by the name alone', () => {
      show(makeShortcut(1, { tvLabel: 'Spotify', iconDataUri: pngIcon(96, 96) }));
      expect(root.querySelectorAll('button')).toHaveLength(1);
      expect(launch().querySelector('app-tv-app-icon img')).not.toBeNull();
      expect(launch().querySelector('.name')?.textContent?.trim()).toBe('Spotify');
      expect(root.querySelector('.package')).toBeNull();
      expect(root.querySelector('.tools')).toBeNull();
    });

    it('names an app by the owner name, then by the name the TV gave, then "Atalho n"', () => {
      show(makeShortcut(3, { customLabel: 'Sala', tvLabel: 'YouTube' }));
      expect(launch().querySelector('.name')?.textContent?.trim()).toBe('Sala');
      update({ shortcut: makeShortcut(3, { tvLabel: 'YouTube' }) });
      expect(launch().querySelector('.name')?.textContent?.trim()).toBe('YouTube');
      update({ shortcut: makeShortcut(3) });
      expect(launch().querySelector('.name')?.textContent?.trim()).toBe('Atalho 3');
    });

    it('says which app was tapped, also when the tap lands on the icon', () => {
      show(makeShortcut(2, { tvLabel: 'Spotify', iconDataUri: pngIcon(96, 96) }));
      root.querySelector<HTMLElement>('.launch img')!.click();
      expect(launched).toHaveBeenCalledWith(expect.objectContaining({ id: 's2' }));
    });

    it('cannot be tapped while the remote cannot send', () => {
      show(makeShortcut(1), { canSend: false });
      expect(launch().disabled).toBe(true);
      launch().click();
      expect(launched).not.toHaveBeenCalled();
    });

    it('an app out of the control is a plain tile and opens like the others', () => {
      show(makeShortcut(1, { enabled: false }));
      expect(root.classList.contains('off')).toBe(false);
      expect(launch().disabled).toBe(false);
      launch().click();
      expect(launched).toHaveBeenCalledWith(
        expect.objectContaining({ id: 's1', enabled: false, installed: true }),
      );
    });

    it('an app that left the TV has nothing to open: the button is shut (the panel does not even list it)', () => {
      show(makeShortcut(1, { enabled: false, installed: false }));
      expect(launch().disabled).toBe(true);
      launch().click();
      expect(launched).not.toHaveBeenCalled();
    });

    it('marks what is in the control only when asked to, with the mark as a description and not in the name', () => {
      show(makeShortcut(1, { tvLabel: 'Spotify' }));
      expect(root.querySelector('.mark')).toBeNull();
      expect(launch().hasAttribute('aria-describedby')).toBe(false);

      update({ marked: true });
      expect(root.querySelector('.mark')).not.toBeNull();
      expect(root.querySelector('.mark')!.getAttribute('aria-hidden')).toBe('true');
      const described = launch().getAttribute('aria-describedby')!;
      expect(root.querySelector(`#${described}`)?.textContent?.trim()).toBe('No controle');
      expect(launch().querySelector('.name')?.textContent?.trim()).toBe('Spotify');

      update({ shortcut: makeShortcut(1, { tvLabel: 'Spotify', enabled: false }) });
      expect(root.querySelector('.mark')).toBeNull();
      expect(launch().hasAttribute('aria-describedby')).toBe(false);
    });
  });

  describe('to manage the app (edit mode)', () => {
    it('opens nothing: there is no launch button, only the name, the package and two buttons', () => {
      show(makeShortcut(1, { tvLabel: 'Spotify' }), { managing: true });
      expect(root.querySelector('.launch')).toBeNull();
      expect(root.querySelector('.name')?.textContent?.trim()).toBe('Spotify');
      expect(root.querySelector('.package')?.textContent?.trim()).toBe('pacote.app1');
      expect(root.querySelectorAll('.tools button')).toHaveLength(2);
    });

    it('offers "Tirar do controle" for a pinned app and "Fixar no controle" for one that is not, named by the app', () => {
      show(makeShortcut(1, { tvLabel: 'Spotify' }), { managing: true });
      expect(pin().getAttribute('aria-label')).toBe('Tirar Spotify do controle');
      expect(pin().classList.contains('on')).toBe(true);
      expect(root.querySelector('.mark')).not.toBeNull();
      update({ shortcut: makeShortcut(1, { tvLabel: 'Spotify', enabled: false }) });
      expect(pin().getAttribute('aria-label')).toBe('Fixar Spotify no controle');
      expect(pin().classList.contains('on')).toBe(false);
      expect(root.querySelector('.mark')).toBeNull();
    });

    it('tells the panel to pin or unpin, and to rename, with the app', () => {
      show(makeShortcut(2, { tvLabel: 'Spotify' }), { managing: true });
      pin().click();
      expect(toggled).toHaveBeenCalledWith(expect.objectContaining({ id: 's2' }));
      const rename = root.querySelector<HTMLButtonElement>('[data-rename]')!;
      expect(rename.getAttribute('aria-label')).toBe('Renomear Spotify');
      expect(rename.getAttribute('data-rename')).toBe('s2');
      rename.click();
      expect(renamed).toHaveBeenCalledWith(expect.objectContaining({ id: 's2' }));
    });

    it('while a request is going the pin is dimmed for readers, but is still a real button (it keeps the focus)', () => {
      show(makeShortcut(1), { managing: true, busy: true });
      expect(pin().getAttribute('aria-disabled')).toBe('true');
      expect(pin().disabled).toBe(false);
      update({ busy: false });
      expect(pin().hasAttribute('aria-disabled')).toBe(false);
    });
  });

  describe('to change the order (edit mode, app in the control)', () => {
    let moved: ReturnType<typeof vi.fn<(move: TileMove) => void>>;
    const showRanked = (index: number, count: number, overrides: Partial<TvShortcut> = {}) => {
      show(makeShortcut(2, { tvLabel: 'Spotify', ...overrides }), {
        managing: true,
        rank: { index, count },
      });
      moved = vi.fn<(move: TileMove) => void>();
      fixture.componentInstance.move.subscribe(moved);
    };
    const left = () => root.querySelector<HTMLButtonElement>('[data-move="left"]')!;
    const right = () => root.querySelector<HTMLButtonElement>('[data-move="right"]')!;

    it('has no move buttons unless the panel says where the app is in the row', () => {
      show(makeShortcut(1), { managing: true });
      expect(root.querySelector('.moves')).toBeNull();
      expect(root.querySelector('[data-move]')).toBeNull();
    });

    it('has two buttons named by the app and the direction, in a row of their own above pin and rename', () => {
      showRanked(1, 3);
      expect(left().getAttribute('aria-label')).toBe('Mover Spotify para a esquerda');
      expect(right().getAttribute('aria-label')).toBe('Mover Spotify para a direita');
      expect(left().getAttribute('data-for')).toBe('s2');
      // Fora de `.tool`: os que contam "fixar e renomear" seguem sendo dois por azulejo.
      expect(left().classList.contains('tool')).toBe(false);
      expect(root.querySelectorAll('.moves button')).toHaveLength(2);
      // Nenhuma linha passa de dois botões: a coluna do azulejo é estreita.
      expect(root.querySelectorAll('.tools button')).toHaveLength(2);
    });

    it('tells the panel which way, with the app', () => {
      showRanked(1, 3);
      left().click();
      expect(moved).toHaveBeenLastCalledWith({
        shortcut: expect.objectContaining({ id: 's2' }),
        delta: -1,
      });
      right().click();
      expect(moved).toHaveBeenLastCalledWith({
        shortcut: expect.objectContaining({ id: 's2' }),
        delta: 1,
      });
    });

    it('at the start the left one is only dimmed (aria-disabled, still a focusable button) and does nothing', () => {
      showRanked(0, 3);
      expect(left().getAttribute('aria-disabled')).toBe('true');
      expect(left().disabled).toBe(false);
      expect(right().hasAttribute('aria-disabled')).toBe(false);
      left().click();
      expect(moved).not.toHaveBeenCalled();
      right().click();
      expect(moved).toHaveBeenCalledTimes(1);
    });

    it('at the end the right one is only dimmed and does nothing', () => {
      showRanked(2, 3);
      expect(right().getAttribute('aria-disabled')).toBe('true');
      expect(right().disabled).toBe(false);
      expect(left().hasAttribute('aria-disabled')).toBe(false);
      right().click();
      expect(moved).not.toHaveBeenCalled();
    });

    it('alone in the row, both are dimmed', () => {
      showRanked(0, 1);
      expect(left().getAttribute('aria-disabled')).toBe('true');
      expect(right().getAttribute('aria-disabled')).toBe('true');
    });

    it('follows the rank when the panel moves the app', () => {
      showRanked(1, 3);
      expect(left().hasAttribute('aria-disabled')).toBe(false);
      update({ rank: { index: 0, count: 3 } });
      expect(left().getAttribute('aria-disabled')).toBe('true');
    });

    it('is named by the new name when the app is renamed', () => {
      showRanked(1, 3);
      update({ shortcut: makeShortcut(2, { customLabel: 'Sala' }) });
      expect(left().getAttribute('aria-label')).toBe('Mover Sala para a esquerda');
    });
  });
});
