import { TestBed } from '@angular/core/testing';
import { TvStore } from '../data/tv-store';
import { TvShortcut } from '../data/tv-types';
import { FakeTvStore, createFakeTvStore, makeShortcut, pngIcon } from '../tv-test-kit';
import { AppPicker } from './app-picker';

describe('AppPicker', () => {
  let store: FakeTvStore;
  let fixture: ReturnType<typeof TestBed.createComponent<AppPicker>>;
  let root: HTMLElement;
  let done: ReturnType<typeof vi.fn<(app: TvShortcut) => void>>;

  /** No controle: Spotify (s1) e Rádio (s2). Fora: Netflix (com ícone), Câmera e YouTube; Max saiu da TV. */
  const tvApps = (): TvShortcut[] => [
    makeShortcut(1, { package: 'com.spotify.tv.android', tvLabel: 'Spotify' }),
    makeShortcut(2, { package: 'com.exemplo.radio', tvLabel: 'Rádio' }),
    makeShortcut(3, {
      package: 'com.netflix.ninja',
      tvLabel: 'Netflix',
      enabled: false,
      iconDataUri: pngIcon(96, 96),
    }),
    makeShortcut(4, { package: 'com.exemplo.camera', tvLabel: 'Câmera', enabled: false }),
    makeShortcut(5, {
      package: 'com.google.android.youtube.tv',
      tvLabel: 'YouTube',
      enabled: false,
    }),
    makeShortcut(6, {
      package: 'com.wbd.stream',
      tvLabel: 'Max',
      enabled: false,
      installed: false,
    }),
  ];

  const mount = (replacing: TvShortcut | null, list: TvShortcut[] = tvApps()) => {
    store = createFakeTvStore();
    store.shortcuts.set(list);
    TestBed.configureTestingModule({ providers: [{ provide: TvStore, useValue: store }] });
    fixture = TestBed.createComponent(AppPicker);
    fixture.componentRef.setInput('replacing', replacing);
    done = vi.fn<(app: TvShortcut) => void>();
    fixture.componentInstance.done.subscribe(done);
    fixture.detectChanges();
    root = fixture.nativeElement;
  };
  const search = () => root.querySelector<HTMLInputElement>('input[type="search"]')!;
  const options = () => [...root.querySelectorAll<HTMLButtonElement>('button.option')];
  const names = () => options().map((b) => b.querySelector('.name')?.textContent?.trim());
  const type = (text: string) => {
    search().value = text;
    search().dispatchEvent(new Event('input'));
    fixture.detectChanges();
  };

  describe('to pin one more app', () => {
    it('lists the installed apps out of the control, brands first, with their icons', () => {
      mount(null);
      expect(names()).toEqual(['YouTube', 'Netflix', 'Câmera']);
      expect(options()[1]!.querySelector('app-tv-app-icon img')).not.toBeNull();
    });

    it('pins the chosen app and says it is done', async () => {
      mount(null);
      options()[2]!.click();
      await fixture.whenStable();
      expect(store.setShortcutEnabled).toHaveBeenCalledExactlyOnceWith('s4', true);
      expect(done).toHaveBeenCalledWith(expect.objectContaining({ id: 's4' }));
    });

    it('says when every app is already in the control', () => {
      mount(null, [makeShortcut(1, { tvLabel: 'Spotify' })]);
      expect(options()).toHaveLength(0);
      expect(root.textContent).toContain('Todos os apps da TV já estão no controle.');
    });
  });

  describe('search', () => {
    it('filters by name without accents or case, and by package, and counts for screen readers', () => {
      mount(null);
      expect(root.querySelector('[role="status"]')?.textContent?.trim()).toBe('3 apps');
      type('camera');
      expect(names()).toEqual(['Câmera']);
      expect(root.querySelector('[role="status"]')?.textContent?.trim()).toBe('1 app');
      type('youtube.tv');
      expect(names()).toEqual(['YouTube']);
      type('nada');
      expect(options()).toHaveLength(0);
      expect(root.textContent).toContain('Nenhum app encontrado para essa busca.');
    });
  });

  describe('to swap a shortcut', () => {
    it('lists every other installed app, marking those already in the control', () => {
      const old = tvApps()[0]!;
      mount(old);
      expect(names()).toEqual(['YouTube', 'Netflix', 'Câmera', 'Rádio']);
      const radio = options()[3]!;
      const markId = radio.getAttribute('aria-describedby')!;
      expect(root.querySelector(`#${markId}`)?.textContent?.trim()).toBe('No controle');
      expect(options()[0]!.hasAttribute('aria-describedby')).toBe(false);
    });

    it("puts the chosen app in the old one's place, pins it and takes the old one out", async () => {
      const old = tvApps()[0]!;
      mount(old);
      options()[1]!.click();
      await fixture.whenStable();
      expect(store.reorder).toHaveBeenCalledWith(['s3', 's1', 's2', 's4', 's5', 's6']);
      expect(store.setShortcutEnabled.mock.calls).toEqual([
        ['s3', true],
        ['s1', false],
      ]);
      expect(done).toHaveBeenCalledTimes(1);
    });

    it('stops at the first step the server refuses, never leaving the row without either app', async () => {
      const old = tvApps()[0]!;
      mount(old);
      store.setShortcutEnabled.mockResolvedValueOnce(false);
      options()[1]!.click();
      await fixture.whenStable();
      expect(store.setShortcutEnabled.mock.calls).toEqual([['s3', true]]);
      expect(done).not.toHaveBeenCalled();
    });
  });

  describe('accessibility', () => {
    it('labels the search field and the list, and every option is a named button', () => {
      mount(null);
      const label = root.querySelector<HTMLLabelElement>(`label[for="${search().id}"]`);
      expect(label?.textContent?.trim()).toBe('Buscar app instalado');
      expect(root.querySelector('ul.options')?.getAttribute('aria-label')).toBe(
        'Apps instalados na TV',
      );
      for (const option of options()) {
        expect(option.getAttribute('type')).toBe('button');
        expect(option.textContent?.trim().length).toBeGreaterThan(0);
      }
    });

    it('moves with the arrow keys between the search and the options', () => {
      mount(null);
      search().focus();
      search().dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
      expect(document.activeElement).toBe(options()[0]);
      options()[0]!.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }),
      );
      expect(document.activeElement).toBe(options()[1]);
      options()[1]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
      options()[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
      expect(document.activeElement).toBe(search());
    });
  });

  it('without any installed app, says why and offers the fix instead of an empty list', () => {
    mount(null, []);
    expect(root.querySelector('app-tv-apps-unavailable')?.textContent).toContain(
      'A TV ainda não informou os apps instalados.',
    );
    expect(root.querySelector('input[type="search"]')).toBeNull();
  });
});
