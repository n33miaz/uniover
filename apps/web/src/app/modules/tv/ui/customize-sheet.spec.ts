import { TestBed } from '@angular/core/testing';
import { TV_PREFS_KEY, TvPrefs } from '../data/tv-prefs';
import { CustomizeSheet } from './customize-sheet';

describe('CustomizeSheet', () => {
  let fixture: ReturnType<typeof TestBed.createComponent<CustomizeSheet>>;
  let root: HTMLElement;
  let closed: ReturnType<typeof vi.fn<() => void>>;

  const prefs = () => TestBed.inject(TvPrefs);
  const field = () => root.querySelector<HTMLInputElement>('#tv-custom-name')!;
  const button = (name: string) =>
    [...root.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.textContent?.trim() === name,
    )!;
  const choices = (group: string) => [
    ...root.querySelectorAll<HTMLButtonElement>(`[aria-labelledby="${group}"] .choice`),
  ];
  const pressed = (group: string) =>
    choices(group)
      .filter((b) => b.getAttribute('aria-pressed') === 'true')
      .map((b) => b.textContent?.trim());
  const toggle = (id: string) =>
    root.querySelector<HTMLInputElement>(`input[aria-labelledby="${id}"]`)!;
  const type = (text: string) => {
    field().value = text;
    field().dispatchEvent(new Event('input', { bubbles: true }));
    fixture.detectChanges();
  };

  const open = async () => {
    fixture = TestBed.createComponent(CustomizeSheet);
    closed = vi.fn<() => void>();
    fixture.componentInstance.closed.subscribe(closed);
    fixture.detectChanges();
    await fixture.whenStable();
    root = fixture.nativeElement;
  };

  beforeEach(() => localStorage.clear());
  afterEach(() => {
    prefs().reset();
    localStorage.clear();
  });

  describe('as it opens', () => {
    beforeEach(open);

    it('is a modal sheet titled Personalizar', () => {
      const dialog = root.querySelector('dialog')!;
      expect(dialog.hasAttribute('open')).toBe(true);
      expect(root.querySelector('h2')?.textContent).toBe('Personalizar');
      expect(dialog.getAttribute('aria-labelledby')).toBe('tv-custom-title');
    });

    it('starts the focus on Concluir, so the keyboard of the phone does not open by itself', () => {
      expect(button('Concluir').hasAttribute('autofocus')).toBe(true);
      expect(button('Concluir').getAttribute('type')).toBe('button');
    });

    it('has a labelled name field limited to 20 characters, with "TV" as the hint', () => {
      expect(root.querySelector('label[for="tv-custom-name"]')?.textContent?.trim()).toBe(
        'Nome da TV',
      );
      expect(field().getAttribute('maxlength')).toBe('20');
      expect(field().placeholder).toBe('TV');
      expect(field().value).toBe('');
      const hint = root.querySelector(`#${field().getAttribute('aria-describedby')}`);
      expect(hint?.textContent).toContain('deixe vazio');
      expect(field().type).toBe('text');
    });

    it('shows the defaults: comfortable, media and channel on, vibration on, last used page, normal speed', () => {
      expect(pressed('tv-custom-size-label')).toEqual(['Confortável']);
      expect(toggle('tv-custom-media').checked).toBe(true);
      expect(toggle('tv-custom-channel').checked).toBe(true);
      expect(toggle('tv-custom-vibration').checked).toBe(true);
      expect(pressed('tv-custom-page-label')).toEqual(['Última usada']);
      expect(pressed('tv-custom-speed-label')).toEqual(['Normal']);
    });

    it('offers every option, each one a button of at least the tap size (44 px by CSS) with its own state', () => {
      expect(choices('tv-custom-size-label').map((b) => b.textContent?.trim())).toEqual([
        'Compacto',
        'Confortável',
        'Grande',
      ]);
      expect(choices('tv-custom-page-label').map((b) => b.textContent?.trim())).toEqual([
        'Direções',
        'Números',
        'Touchpad',
        'Última usada',
      ]);
      expect(choices('tv-custom-speed-label').map((b) => b.textContent?.trim())).toEqual([
        'Lenta',
        'Normal',
        'Rápida',
      ]);
      for (const choice of root.querySelectorAll('.choice')) {
        expect(choice.getAttribute('type')).toBe('button');
        expect(['true', 'false']).toContain(choice.getAttribute('aria-pressed'));
      }
    });

    it('names every switch by its title and describes it by its sub-line', () => {
      for (const id of ['tv-custom-media', 'tv-custom-channel', 'tv-custom-vibration']) {
        const input = toggle(id);
        expect(input.getAttribute('role')).toBe('switch');
        expect(root.querySelector(`#${id}`)?.textContent?.trim()).toBeTruthy();
        const description = root.querySelector(`#${input.getAttribute('aria-describedby')}`);
        expect(description?.textContent?.trim()).toBeTruthy();
      }
    });

    it('has no way to close other than Concluir and Esc, and Restaurar starts off while nothing changed', () => {
      expect(
        [...root.querySelectorAll('button')]
          .map((b) => b.textContent?.trim())
          .filter((text) => ['Concluir', 'Restaurar padrão'].includes(text ?? '')),
      ).toEqual(['Restaurar padrão', 'Concluir']);
      expect(button('Restaurar padrão').disabled).toBe(true);
    });
  });

  describe('changing a choice', () => {
    beforeEach(open);

    it('takes the name as it is typed, at once, and keeps it on the device', () => {
      type('Sala');
      expect(prefs().title()).toBe('Sala');
      expect(JSON.parse(localStorage.getItem(TV_PREFS_KEY) ?? 'null').name).toBe('Sala');
    });

    it('does not eat the space typed after a word: the field keeps what was typed', () => {
      type('TV ');
      expect(field().value).toBe('TV ');
      expect(prefs().name()).toBe('TV');
      type('TV da');
      expect(prefs().name()).toBe('TV da');
    });

    it('applies the size, the page and the speed, marking only the chosen one', () => {
      choices('tv-custom-size-label')[2].click();
      fixture.detectChanges();
      expect(prefs().buttonSize()).toBe('large');
      expect(pressed('tv-custom-size-label')).toEqual(['Grande']);

      choices('tv-custom-page-label')[1].click();
      choices('tv-custom-speed-label')[2].click();
      fixture.detectChanges();
      expect(prefs().startPage()).toBe('numbers');
      expect(prefs().padSpeed()).toBe('fast');
      expect(pressed('tv-custom-page-label')).toEqual(['Números']);
      expect(pressed('tv-custom-speed-label')).toEqual(['Rápida']);
    });

    it('turns the media keys, the channel and the vibration off and on', () => {
      for (const [id, read] of [
        ['tv-custom-media', () => prefs().showMedia()],
        ['tv-custom-channel', () => prefs().showChannel()],
        ['tv-custom-vibration', () => prefs().vibration()],
      ] as const) {
        const input = toggle(id);
        input.checked = false;
        input.dispatchEvent(new Event('change', { bubbles: true }));
        expect(read(), `${id} off`).toBe(false);
        input.checked = true;
        input.dispatchEvent(new Event('change', { bubbles: true }));
        expect(read(), `${id} on`).toBe(true);
      }
    });
  });

  describe('Restaurar padrão', () => {
    beforeEach(open);

    it('puts every choice back, empties the field and leaves the focus on Concluir', () => {
      type('Sala');
      choices('tv-custom-size-label')[0].click();
      toggle('tv-custom-media').click();
      choices('tv-custom-speed-label')[0].click();
      fixture.detectChanges();
      expect(button('Restaurar padrão').disabled).toBe(false);

      button('Restaurar padrão').click();
      fixture.detectChanges();
      expect(field().value).toBe('');
      expect(prefs().title()).toBe('TV');
      expect(prefs().buttonSize()).toBe('comfortable');
      expect(prefs().showMedia()).toBe(true);
      expect(prefs().padSpeed()).toBe('normal');
      expect(pressed('tv-custom-size-label')).toEqual(['Confortável']);
      expect(toggle('tv-custom-media').checked).toBe(true);
      expect(button('Restaurar padrão').disabled).toBe(true);
      expect(document.activeElement).toBe(button('Concluir'));
    });
  });

  describe('leaving', () => {
    beforeEach(open);

    it('Concluir closes the sheet and changes nothing', () => {
      type('Sala');
      button('Concluir').click();
      expect(closed).toHaveBeenCalledTimes(1);
      expect(prefs().title()).toBe('Sala');
    });

    it('Esc closes it the same way, and stops the browser from closing it twice', () => {
      const event = new Event('cancel', { cancelable: true });
      root.querySelector('dialog')!.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
      expect(closed).toHaveBeenCalledTimes(1);
    });
  });

  describe('opening again', () => {
    it('starts with the name already chosen', async () => {
      prefs().set({ name: 'Quarto' });
      await open();
      expect(field().value).toBe('Quarto');
    });
  });
});
