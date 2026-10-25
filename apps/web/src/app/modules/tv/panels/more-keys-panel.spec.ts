import { TestBed } from '@angular/core/testing';
import { TvPrefs } from '../data/tv-prefs';
import { TvSelection } from '../data/tv-selection';
import { TvStore } from '../data/tv-store';
import { FakeTvStore, createFakeTvStore, makeTv } from '../tv-test-kit';
import { MoreKeysPanel } from './more-keys-panel';

describe('MoreKeysPanel', () => {
  let store: FakeTvStore;
  let root: HTMLElement;
  const buttons = () => [...root.querySelectorAll<HTMLButtonElement>('button.key')];
  const names = () => buttons().map((button) => button.querySelector('.name')?.textContent?.trim());

  beforeEach(() => {
    localStorage.clear();
    store = createFakeTvStore();
    TestBed.configureTestingModule({ providers: [{ provide: TvStore, useValue: store }] });
    TestBed.inject(TvSelection).setTvs([
      makeTv('tv', {
        isDefault: true,
        kind: 'samsung',
        capabilities: [
          'tv.remote',
          'tv.kind.samsung',
          'tv.key.v3',
          ...['INPUT', 'GUIDE', 'RED', 'PLAY'].map((key) => `tv.key.${key}`),
        ],
      }),
    ]);
    const fixture = TestBed.createComponent(MoreKeysPanel);
    fixture.detectChanges();
    root = fixture.nativeElement;
  });
  afterEach(() => {
    TestBed.inject(TvPrefs).reset();
    localStorage.clear();
  });

  it('lists the keys the TV has that the main screen does not show, by name', () => {
    expect(names()).toEqual(['Guia', 'Reproduzir', 'Vermelho']);
    expect(buttons()[2]!.querySelector('.swatch')?.getAttribute('data-color')).toBe('red');
    expect(buttons()[1]!.querySelector('app-tv-icon')).not.toBeNull();
    expect(buttons()[0]!.querySelector('.word')?.textContent).toBe('Guia');
  });

  it('sends the key of the button that was tapped', () => {
    buttons()[0]!.click();
    expect(store.sendKey).toHaveBeenCalledWith('GUIDE');
  });
});
