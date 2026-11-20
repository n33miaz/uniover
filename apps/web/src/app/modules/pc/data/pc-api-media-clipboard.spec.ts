import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { OPERATION_HEADER } from './pc-operation';
import { PcApi } from './pc-api';
import { PC_CLIPBOARD_MAX, clipboardTextFits, playbackStatusOf } from './pc-types';

describe('PcApi now playing and clipboard', () => {
  let api: PcApi;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    api = TestBed.inject(PcApi);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('asks what is playing with a plain GET and maps the answer', async () => {
    const reading = api.nowPlaying();
    const request = http.expectOne((req) => req.url.endsWith('/v1/pc/now-playing'));
    expect(request.request.method).toBe('GET');
    request.flush({
      status: 'paused',
      title: 'Águas de Março',
      artist: 'Elis Regina',
      app: 'Spotify.exe',
      at: '2026-11-14T12:00:00Z',
    });
    expect(await reading).toEqual({
      status: 'paused',
      title: 'Águas de Março',
      artist: 'Elis Regina',
      app: 'Spotify.exe',
    });
  });

  it('reads the clipboard with a POST that carries the operation, and returns the text', async () => {
    const reading = api.readClipboard();
    const request = http.expectOne((req) => req.url.endsWith('/v1/pc/clipboard/read'));
    expect(request.request.method).toBe('POST');
    expect(request.request.body).toBeNull();
    expect(request.request.headers.has(OPERATION_HEADER)).toBe(true);
    request.flush({ text: 'senha' });
    expect(await reading).toBe('senha');
  });

  it('writes only the text to the clipboard, with no numbering', async () => {
    const writing = api.writeClipboard('linha 1\nlinha 2');
    const request = http.expectOne((req) => req.url.endsWith('/v1/pc/clipboard/write'));
    expect(request.request.body).toEqual({ text: 'linha 1\nlinha 2' });
    request.flush(null, { status: 204, statusText: 'No Content' });
    await writing;
  });

  it('a failed read rejects, so the store turns it into a failure', async () => {
    const reading = api.readClipboard();
    http
      .expectOne((req) => req.url.endsWith('/v1/pc/clipboard/read'))
      .flush({ type: 'x/pc-key-unsupported' }, { status: 409, statusText: 'Conflict' });
    await expect(reading).rejects.toBeTruthy();
  });
});

describe('clipboard and playback helpers', () => {
  it.each([
    ['olá', true],
    ['linha 1\r\nlinha 2\tfim', true],
    ['', false],
    ['a\u0000b', false],
    ['a\u001bb', false],
    ['a\u007fb', false],
    ['a\u0085b', false],
  ])('%j fits the clipboard: %s', (text, fits) => {
    expect(clipboardTextFits(text)).toBe(fits);
  });

  it('accepts up to the contract limit', () => {
    expect(clipboardTextFits('x'.repeat(PC_CLIPBOARD_MAX))).toBe(true);
    expect(clipboardTextFits('x'.repeat(PC_CLIPBOARD_MAX + 1))).toBe(false);
  });

  it('a status the screen does not know counts as stopped', () => {
    expect(playbackStatusOf('playing')).toBe('playing');
    expect(playbackStatusOf('none')).toBe('none');
    expect(playbackStatusOf('buffering')).toBe('stopped');
  });
});
