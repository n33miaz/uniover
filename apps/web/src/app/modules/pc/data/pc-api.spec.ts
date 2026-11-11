import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { PcApi } from './pc-api';
import { PcDirect } from './pc-direct';

describe('PcApi click', () => {
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

  it('sends the button and the action as a plain request by default', async () => {
    const sending = api.click('LEFT', 'DOWN');
    const request = http.expectOne((req) => req.url.endsWith('/v1/pc/click'));
    expect(request.request.body).toEqual({
      button: 'LEFT',
      action: 'DOWN',
      seq: expect.any(Number),
      epoch: expect.stringMatching(/^[0-9a-f]{16}$/),
    });
    expect(request.request.keepalive).toBe(false);
    request.flush(null, { status: 204, statusText: 'No Content' });
    await sending;
  });

  it('keepalive is passed to the request, so the browser finishes it even if the page goes away', async () => {
    const sending = api.click('LEFT', 'UP', { keepalive: true });
    const request = http.expectOne((req) => req.url.endsWith('/v1/pc/click'));
    expect(request.request.body).toEqual({
      button: 'LEFT',
      action: 'UP',
      seq: expect.any(Number),
      epoch: expect.any(String),
    });
    expect(request.request.keepalive).toBe(true);
    request.flush(null, { status: 204, statusText: 'No Content' });
    await sending;
  });
});

describe('PcApi click with modifiers and gap', () => {
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

  async function body(sending: Promise<void>) {
    const request = http.expectOne((req) => req.url.endsWith('/v1/pc/click'));
    request.flush(null, { status: 204, statusText: 'No Content' });
    await sending;
    const { seq, epoch, ...rest } = request.request.body as Record<string, unknown>;
    expect(typeof seq).toBe('number');
    expect(epoch).toMatch(/^[0-9a-f]{16}$/);
    return rest;
  }

  it('a plain click goes out exactly as it always did, so the API can send the v1', async () => {
    expect(await body(api.click('LEFT'))).toEqual({ button: 'LEFT' });
    expect(await body(api.click('LEFT', 'DOUBLE', { modifiers: [], gapMs: 0 }))).toEqual({
      button: 'LEFT',
      action: 'DOUBLE',
    });
  });

  it('carries the modifiers and the gap only when they change something', async () => {
    expect(await body(api.click('LEFT', undefined, { modifiers: ['CTRL', 'SHIFT'] }))).toEqual({
      button: 'LEFT',
      modifiers: ['CTRL', 'SHIFT'],
    });
    expect(await body(api.click('LEFT', undefined, { gapMs: 120.4 }))).toEqual({
      button: 'LEFT',
      gapMs: 120,
    });
  });

  it('keeps the gap inside what the contract allows', async () => {
    expect(await body(api.click('LEFT', undefined, { gapMs: 9_000 }))).toEqual({
      button: 'LEFT',
      gapMs: 400,
    });
    expect(await body(api.click('LEFT', undefined, { gapMs: -5 }))).toEqual({ button: 'LEFT' });
    expect(await body(api.click('LEFT', undefined, { gapMs: Number.NaN }))).toEqual({
      button: 'LEFT',
    });
  });
});

describe('PcApi text edit', () => {
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

  async function body(sending: Promise<void>) {
    const request = http.expectOne((req) => req.url.endsWith('/v1/pc/text'));
    request.flush(null, { status: 204, statusText: 'No Content' });
    await sending;
    const { seq, epoch, ...rest } = request.request.body as Record<string, unknown>;
    expect(typeof seq).toBe('number');
    expect(epoch).toMatch(/^[0-9a-f]{16}$/);
    return rest;
  }

  it('sends only what the edit has', async () => {
    expect(await body(api.edit({ text: 'olá' }))).toEqual({ text: 'olá' });
    expect(await body(api.edit({ erase: 3, text: 'olá', key: 'ENTER' }))).toEqual({
      erase: 3,
      text: 'olá',
      key: 'ENTER',
    });
    expect(await body(api.edit({ erase: 4 }))).toEqual({ erase: 4 });
    expect(await body(api.edit({ key: 'TAB' }))).toEqual({ key: 'TAB' });
    expect(await body(api.edit({ erase: 0, text: 'a' }))).toEqual({ text: 'a' });
  });

  it('keeps the erase inside what the contract allows', async () => {
    expect(await body(api.edit({ erase: 5_000 }))).toEqual({ erase: 200 });
  });
});

describe('PcApi key', () => {
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

  async function body(sending: Promise<void>) {
    const request = http.expectOne((req) => req.url.endsWith('/v1/pc/key'));
    request.flush(null, { status: 204, statusText: 'No Content' });
    await sending;
    // Todo pedido da nuvem leva o número do contador comum; o resto do corpo é o de sempre.
    const { seq, epoch, ...rest } = request.request.body as Record<string, unknown>;
    expect(typeof seq).toBe('number');
    expect(epoch).toMatch(/^[0-9a-f]{16}$/);
    return rest;
  }

  it('a plain key goes out exactly as it always did, so the API can send the v1', async () => {
    expect(await body(api.key('ENTER'))).toEqual({ key: 'ENTER' });
    expect(await body(api.key('C', ['CTRL']))).toEqual({ key: 'C', modifiers: ['CTRL'] });
    expect(await body(api.key('C', [], { repeat: 1, action: 'PRESS' }))).toEqual({ key: 'C' });
  });

  it('carries the repeat and the action only when they change something', async () => {
    expect(await body(api.key('BACKSPACE', [], { repeat: 12 }))).toEqual({
      key: 'BACKSPACE',
      repeat: 12,
    });
    expect(await body(api.key('ALT', [], { action: 'DOWN' }))).toEqual({
      key: 'ALT',
      action: 'DOWN',
    });
    expect(await body(api.key('ALT', [], { action: 'UP' }))).toEqual({ key: 'ALT', action: 'UP' });
    expect(await body(api.key('D0', ['CTRL']))).toEqual({ key: 'D0', modifiers: ['CTRL'] });
  });

  it('keeps the repeat inside what the contract allows', async () => {
    expect(await body(api.key('DOWN', [], { repeat: 500 }))).toEqual({ key: 'DOWN', repeat: 50 });
    expect(await body(api.key('DOWN', [], { repeat: 7.9 }))).toEqual({ key: 'DOWN', repeat: 7 });
    expect(await body(api.key('DOWN', [], { repeat: 0 }))).toEqual({ key: 'DOWN' });
    expect(await body(api.key('DOWN', [], { repeat: Number.NaN }))).toEqual({ key: 'DOWN' });
  });
});

describe('PcApi keyRelease', () => {
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

  it('releases a modifier on its own route, as a plain request by default', async () => {
    const sending = api.keyRelease('ALT');
    const request = http.expectOne((req) => req.url.endsWith('/v1/pc/key/release'));
    expect(request.request.body).toEqual({
      key: 'ALT',
      seq: expect.any(Number),
      epoch: expect.any(String),
    });
    expect(request.request.keepalive).toBe(false);
    request.flush(null, { status: 204, statusText: 'No Content' });
    await sending;
  });

  it('keepalive is passed to the request, so the browser finishes it even if the page goes away', async () => {
    const sending = api.keyRelease('SHIFT', { keepalive: true });
    const request = http.expectOne((req) => req.url.endsWith('/v1/pc/key/release'));
    expect(request.request.keepalive).toBe(true);
    request.flush(null, { status: 204, statusText: 'No Content' });
    await sending;
  });
});

describe('PcApi cloud sequence', () => {
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

  it('numbers every click, key, release, text and media request with one growing counter', async () => {
    const seqs: number[] = [];
    const answer = async (sending: Promise<void>, path: string) => {
      const request = http.expectOne((req) => req.url.endsWith(path));
      seqs.push((request.request.body as { seq: number }).seq);
      request.flush(null, { status: 204, statusText: 'No Content' });
      await sending;
    };

    await answer(api.click('LEFT'), '/v1/pc/click');
    await answer(api.key('ENTER'), '/v1/pc/key');
    await answer(api.keyRelease('ALT'), '/v1/pc/key/release');
    await answer(api.text('abc'), '/v1/pc/text');
    await answer(api.media('MUTE'), '/v1/pc/media');

    expect(seqs).toEqual([1, 2, 3, 4, 5]);
  });

  it('every numbered request carries the same epoch (the one of this page)', async () => {
    const epochs: string[] = [];
    const answer = async (sending: Promise<void>, path: string) => {
      const request = http.expectOne((req) => req.url.endsWith(path));
      epochs.push((request.request.body as { epoch: string }).epoch);
      request.flush(null, { status: 204, statusText: 'No Content' });
      await sending;
    };

    await answer(api.click('LEFT'), '/v1/pc/click');
    await answer(api.text('abc'), '/v1/pc/text');
    await answer(api.media('MUTE'), '/v1/pc/media');

    expect(new Set(epochs).size).toBe(1);
    expect(epochs[0]).toBe(TestBed.inject(PcDirect).cloudEpoch);
  });

  it('the pointer keeps the numbering the batcher gives it, and never takes a number from the counter', async () => {
    const pointer = api.pointer(1, 1, 0, 0, 77);
    const request = http.expectOne((req) => req.url.endsWith('/v1/pc/pointer'));
    expect((request.request.body as { seq: number }).seq).toBe(77);
    request.flush(null, { status: 204, statusText: 'No Content' });
    await pointer;

    const sending = api.text('x');
    const next = http.expectOne((req) => req.url.endsWith('/v1/pc/text'));
    expect((next.request.body as { seq: number }).seq).toBe(1);
    next.flush(null, { status: 204, statusText: 'No Content' });
    await sending;
  });

  it('power and favorites are not numbered (only the cloud takes them, and they never close the channel)', async () => {
    const sending = api.power('LOCK');
    const request = http.expectOne((req) => req.url.endsWith('/v1/pc/power'));
    expect(request.request.body).toEqual({ action: 'LOCK' });
    request.flush(null, { status: 204, statusText: 'No Content' });
    await sending;
  });
});

describe('PcApi pointer', () => {
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

  async function body(sending: Promise<void>) {
    const request = http.expectOne((req) => req.url.endsWith('/v1/pc/pointer'));
    request.flush(null, { status: 204, statusText: 'No Content' });
    await sending;
    return request.request.body;
  }

  it('sends only the axes (no sequence) for the heartbeat of a held button', async () => {
    expect(await body(api.pointer(0, 0))).toEqual({ dx: 0, dy: 0 });
  });

  it('carries the sequence of the request when there is one, zero included', async () => {
    expect(await body(api.pointer(3, -2, 0, 120, 4821))).toEqual({
      dx: 3,
      dy: -2,
      scrollY: 120,
      seq: 4821,
    });
    expect(await body(api.pointer(1, 1, 0, 0, 0))).toEqual({ dx: 1, dy: 1, seq: 0 });
  });
});

describe('PcApi operation id', () => {
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

  const done = { status: 204, statusText: 'No Content' };

  it('every command through the cloud carries its own X-Operation-Id', async () => {
    const calls: [string, () => Promise<void>][] = [
      ['click', () => api.click('LEFT')],
      ['key', () => api.key('ENTER')],
      ['text', () => api.text('olá')],
      ['media', () => api.media('MUTE')],
      ['zoom', () => api.zoom(2)],
      ['volume', () => api.volume({ level: 30 })],
      ['power', () => api.power('LOCK')],
    ];
    const seen = new Set<string>();
    for (const [path, call] of calls) {
      const sending = call();
      const request = http.expectOne((req) => req.url.endsWith(`/v1/pc/${path}`));
      const id = request.request.headers.get('X-Operation-Id');
      expect(id).toMatch(/^[0-9a-f]{16}$/);
      seen.add(id!);
      request.flush(null, done);
      await sending;
    }
    expect(seen.size).toBe(calls.length);
  });

  it('the pointer is high rate and never carries an operation', async () => {
    const sending = api.pointer(3, 4);
    const request = http.expectOne((req) => req.url.endsWith('/v1/pc/pointer'));
    expect(request.request.headers.has('X-Operation-Id')).toBe(false);
    request.flush(null, done);
    await sending;
  });

  it('a favorite launched through the cloud carries it too', async () => {
    const sending = api.launch('navegador');
    const request = http.expectOne((req) => req.url.endsWith('/v1/pc/apps/navegador/launch'));
    expect(request.request.headers.get('X-Operation-Id')).toMatch(/^[0-9a-f]{16}$/);
    request.flush(null, done);
    await sending;
  });
});
