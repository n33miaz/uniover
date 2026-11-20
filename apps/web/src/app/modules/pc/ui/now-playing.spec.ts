import { TestBed } from '@angular/core/testing';
import { PcStore } from '../data/pc-store';
import type { PcNowPlaying } from '../data/pc-types';
import { FakePcStore, createFakePcStore } from '../pc-test-kit';
import {
  NOW_PLAYING_AFTER_KEY_MS,
  NOW_PLAYING_POLL_MS,
  PcNowPlayingPanel,
  appLabel,
} from './now-playing';

const TRACK: PcNowPlaying = {
  status: 'playing',
  title: 'Águas de Março',
  artist: 'Elis Regina',
  app: 'Spotify.exe',
};

describe('PcNowPlayingPanel', () => {
  let store: FakePcStore;
  let fixture: ReturnType<typeof TestBed.createComponent<PcNowPlayingPanel>>;
  let root: HTMLElement;

  const flush = async () => {
    for (let round = 0; round < 8; round++) await Promise.resolve();
    fixture.detectChanges();
  };

  function create(capabilities: readonly string[] = ['pc.media.state.v1']): void {
    store.capabilities.set(capabilities);
    fixture = TestBed.createComponent(PcNowPlayingPanel);
    fixture.detectChanges();
    root = fixture.nativeElement;
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    store = createFakePcStore();
    store.nowPlaying.mockResolvedValue(TRACK);
    TestBed.configureTestingModule({ providers: [{ provide: PcStore, useValue: store }] });
  });

  afterEach(() => {
    fixture.destroy();
    vi.useRealTimers();
  });

  it('shows nothing and never asks a PC that did not declare it', async () => {
    create([]);
    await flush();
    vi.advanceTimersByTime(NOW_PLAYING_POLL_MS * 3);
    expect(store.nowPlaying).not.toHaveBeenCalled();
    expect(root.querySelector('.now')).toBeNull();
  });

  it('asks on opening and shows the title, the artist and the program', async () => {
    create();
    await flush();
    expect(store.nowPlaying).toHaveBeenCalledOnce();
    expect(root.querySelector('h2')?.textContent?.trim()).toBe('Tocando Agora');
    expect(root.querySelector('.title')?.textContent).toBe('Águas de Março');
    expect(root.querySelector('.artist')?.textContent).toBe('Elis Regina');
    expect(root.querySelector('.app')?.textContent).toBe('Spotify');
  });

  it('asks again on every cycle while the PC is connected, and stops when it drops', async () => {
    create();
    await flush();
    vi.advanceTimersByTime(NOW_PLAYING_POLL_MS);
    await flush();
    expect(store.nowPlaying).toHaveBeenCalledTimes(2);

    store.phase.set('offline');
    fixture.detectChanges();
    await flush();
    vi.advanceTimersByTime(NOW_PLAYING_POLL_MS * 3);
    await flush();
    expect(store.nowPlaying).toHaveBeenCalledTimes(2);
  });

  it('does not ask while inactive (another media mode open)', async () => {
    store.capabilities.set(['pc.media.state.v1']);
    fixture = TestBed.createComponent(PcNowPlayingPanel);
    fixture.componentRef.setInput('active', false);
    fixture.detectChanges();
    root = fixture.nativeElement;
    await flush();
    vi.advanceTimersByTime(NOW_PLAYING_POLL_MS * 2);
    expect(store.nowPlaying).not.toHaveBeenCalled();
  });

  it('says when nothing is playing, and when it is paused', async () => {
    store.nowPlaying.mockResolvedValue({ status: 'none', title: '', artist: '', app: '' });
    create();
    await flush();
    expect(root.querySelector('h2')?.textContent?.trim()).toBe('Nada Tocando no PC');
    expect(root.querySelector('.title')).toBeNull();

    store.nowPlaying.mockResolvedValue({ ...TRACK, status: 'paused' });
    vi.advanceTimersByTime(NOW_PLAYING_POLL_MS);
    await flush();
    expect(root.querySelector('h2')?.textContent?.trim()).toBe('Pausado');
  });

  it('keeps the last track when a read fails, instead of blanking it', async () => {
    create();
    await flush();
    store.nowPlaying.mockResolvedValue(null);
    vi.advanceTimersByTime(NOW_PLAYING_POLL_MS);
    await flush();
    expect(root.querySelector('.title')?.textContent).toBe('Águas de Março');
  });

  it('refreshSoon asks again shortly after a media key', async () => {
    create();
    await flush();
    fixture.componentInstance.refreshSoon();
    vi.advanceTimersByTime(NOW_PLAYING_AFTER_KEY_MS - 1);
    expect(store.nowPlaying).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(1);
    await flush();
    expect(store.nowPlaying).toHaveBeenCalledTimes(2);
  });

  it('never overlaps two questions', async () => {
    let answer: (value: PcNowPlaying | null) => void = () => undefined;
    store.nowPlaying.mockImplementation(
      () => new Promise<PcNowPlaying | null>((resolve) => (answer = resolve)),
    );
    create();
    await flush();
    vi.advanceTimersByTime(NOW_PLAYING_POLL_MS * 2);
    await flush();
    expect(store.nowPlaying).toHaveBeenCalledOnce();
    answer(TRACK);
    await flush();
    vi.advanceTimersByTime(NOW_PLAYING_POLL_MS);
    await flush();
    expect(store.nowPlaying).toHaveBeenCalledTimes(2);
  });
});

describe('appLabel', () => {
  it.each([
    ['Spotify.exe', 'Spotify'],
    ['Microsoft.ZuneMusic_8wekyb3d8bbwe!Microsoft.ZuneMusic', 'ZuneMusic'],
    ['MSEdge', 'MSEdge'],
    ['C:\\Programas\\VLC\\vlc.exe', 'vlc'],
    ['', ''],
  ])('%j becomes %j', (app, label) => {
    expect(appLabel(app)).toBe(label);
  });
});
