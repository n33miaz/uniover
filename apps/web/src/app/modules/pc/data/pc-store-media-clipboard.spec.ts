import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { HttpErrorResponse } from '@angular/common/http';
import { PcAvailability, type PcStatus } from '../../../core/modules/pc-availability';
import { status } from '../pc-test-kit';
import { PcApi } from './pc-api';
import { PcStore } from './pc-store';
import type { PcNowPlaying } from './pc-types';

const TRACK: PcNowPlaying = { status: 'playing', title: 't', artist: 'a', app: 'Spotify.exe' };

function setup(initial: PcStatus | null = status()) {
  const current = signal<PcStatus | null>(initial);
  const availability = {
    status: current.asReadonly(),
    apps: () => current()?.apps ?? [],
    capabilities: () => current()?.capabilities ?? [],
    volume: () => current()?.volume ?? null,
    refresh: vi.fn(() => Promise.resolve(true)),
  };
  const api = {
    nowPlaying: vi.fn<() => Promise<PcNowPlaying>>(() => Promise.resolve(TRACK)),
    readClipboard: vi.fn<() => Promise<string>>(() => Promise.resolve('copiado')),
    writeClipboard: vi.fn<(text: string) => Promise<void>>(() => Promise.resolve()),
  };
  TestBed.configureTestingModule({
    providers: [
      { provide: PcAvailability, useValue: availability },
      { provide: PcApi, useValue: api },
    ],
  });
  return { store: TestBed.inject(PcStore), api, current };
}

const ALL = ['pc.power.v2', 'pc.power.hibernate.v1', 'pc.media.state.v1', 'pc.clipboard.v1'];

describe('PcStore hibernate, now playing and clipboard capabilities', () => {
  it('knows none of them until the agent declares them', () => {
    const { store } = setup(status());
    expect(store.supportsHibernate()).toBe(false);
    expect(store.supportsNowPlaying()).toBe(false);
    expect(store.supportsClipboard()).toBe(false);
  });

  it('knows each one once declared', () => {
    const { store } = setup(status({ capabilities: ALL }));
    expect(store.supportsHibernate()).toBe(true);
    expect(store.supportsNowPlaying()).toBe(true);
    expect(store.supportsClipboard()).toBe(true);
  });

  it('hibernate needs the power v2 too', () => {
    const { store } = setup(status({ capabilities: ['pc.power.hibernate.v1'] }));
    expect(store.supportsHibernate()).toBe(false);
  });
});

describe('PcStore now playing', () => {
  it('asks the API and returns what the PC said', async () => {
    const { store, api } = setup(status({ capabilities: ALL }));
    expect(await store.nowPlaying()).toEqual(TRACK);
    expect(api.nowPlaying).toHaveBeenCalledOnce();
  });

  it('never asks a PC that is offline or did not declare it', async () => {
    const offline = setup(status({ online: false, capabilities: ALL }));
    expect(await offline.store.nowPlaying()).toBeNull();
    expect(offline.api.nowPlaying).not.toHaveBeenCalled();

    TestBed.resetTestingModule();
    const older = setup(status());
    expect(await older.store.nowPlaying()).toBeNull();
    expect(older.api.nowPlaying).not.toHaveBeenCalled();
  });

  it('a failed read is quiet: no notice, just nothing this time', async () => {
    const { store, api } = setup(status({ capabilities: ALL }));
    api.nowPlaying.mockRejectedValueOnce(new HttpErrorResponse({ status: 502 }));
    expect(await store.nowPlaying()).toBeNull();
    expect(store.notice()).toBeNull();
  });
});

describe('PcStore clipboard', () => {
  it('reads the text of the PC', async () => {
    const { store } = setup(status({ capabilities: ALL }));
    expect(await store.readClipboard()).toEqual({ ok: true, value: 'copiado' });
  });

  it('a failed read comes back as a failure with its message', async () => {
    const { store, api } = setup(status({ capabilities: ALL }));
    api.readClipboard.mockRejectedValueOnce(new HttpErrorResponse({ status: 504 }));
    const read = await store.readClipboard();
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.failure.message.length).toBeGreaterThan(0);
  });

  it('a read with the PC offline sends nothing', async () => {
    const { store, api } = setup(status({ online: false, capabilities: ALL }));
    const read = await store.readClipboard();
    expect(read.ok).toBe(false);
    expect(api.readClipboard).not.toHaveBeenCalled();
  });

  it('writes the text and reports success as null', async () => {
    const { store, api } = setup(status({ capabilities: ALL }));
    expect(await store.writeClipboard('olá')).toBeNull();
    expect(api.writeClipboard).toHaveBeenCalledExactlyOnceWith('olá');
  });
});
