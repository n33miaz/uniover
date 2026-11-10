import { HttpErrorResponse, provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { PcApi } from './pc-api';
import { DirectNotSent, PcDirect } from './pc-direct';

/** O canal direto de mentira: o teste diz se pode levar o comando e o que ele responde. */
function setup(options: { canUse?: boolean } = {}) {
  let cloudSeq = 0;
  const direct = {
    canUse: vi.fn(() => options.canUse ?? false),
    accepts: vi.fn<(type: string) => boolean>(() => true),
    nextCloudSeq: vi.fn(() => ++cloudSeq),
    cloudEpoch: '3fa9c10d7be2465a',
    command: vi.fn<(type: string, body: Record<string, unknown>) => Promise<void>>(() =>
      Promise.resolve(),
    ),
    sendPointer: vi.fn(),
    trackCloud: vi.fn(<T>(call: Promise<T>) => call),
  };
  TestBed.configureTestingModule({
    providers: [
      provideHttpClient(),
      provideHttpClientTesting(),
      { provide: PcDirect, useValue: direct },
    ],
  });
  return { api: TestBed.inject(PcApi), http: TestBed.inject(HttpTestingController), direct };
}

const noContent = { status: 204, statusText: 'No Content' };
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('PcApi zoom and volume through the cloud', () => {
  afterEach(() => TestBed.inject(HttpTestingController).verify());

  it('zoom is its own route, with the steps, the sequence and the page epoch', async () => {
    const { api, http } = setup();
    const sending = api.zoom(3);
    await tick();
    const request = http.expectOne((req) => req.url.endsWith('/v1/pc/zoom'));
    expect(request.request.method).toBe('POST');
    expect(request.request.body).toEqual({
      steps: 3,
      seq: 1,
      epoch: '3fa9c10d7be2465a',
    });
    request.flush(null, noContent);
    await sending;
  });

  it('zoom keeps the steps inside what the contract allows, with the sign, and sends nothing for zero', async () => {
    const { api, http } = setup();
    const big = api.zoom(99);
    await tick();
    const first = http.expectOne((req) => req.url.endsWith('/v1/pc/zoom'));
    expect((first.request.body as { steps: number }).steps).toBe(12);
    first.flush(null, noContent);
    await big;

    const small = api.zoom(-99);
    await tick();
    const second = http.expectOne((req) => req.url.endsWith('/v1/pc/zoom'));
    expect((second.request.body as { steps: number }).steps).toBe(-12);
    second.flush(null, noContent);
    await small;

    await api.zoom(0);
    await api.zoom(Number.NaN);
    http.expectNone((req) => req.url.endsWith('/v1/pc/zoom'));
  });

  it('volume is its own route, and carries only what changes', async () => {
    const { api, http } = setup();
    const level = api.volume({ level: 41.6 });
    await tick();
    const first = http.expectOne((req) => req.url.endsWith('/v1/pc/volume'));
    expect(first.request.body).toEqual({ level: 42, seq: 1, epoch: '3fa9c10d7be2465a' });
    first.flush(null, noContent);
    await level;

    const muted = api.volume({ muted: true });
    await tick();
    const second = http.expectOne((req) => req.url.endsWith('/v1/pc/volume'));
    expect(second.request.body).toEqual({ muted: true, seq: 2, epoch: '3fa9c10d7be2465a' });
    second.flush(null, noContent);
    await muted;

    const both = api.volume({ level: 0, muted: false });
    await tick();
    const third = http.expectOne((req) => req.url.endsWith('/v1/pc/volume'));
    expect(third.request.body).toEqual({
      level: 0,
      muted: false,
      seq: 3,
      epoch: '3fa9c10d7be2465a',
    });
    third.flush(null, noContent);
    await both;
  });

  it('volume keeps the level from 0 to 100, and sends nothing for a change with nothing in it', async () => {
    const { api, http } = setup();
    const high = api.volume({ level: 400 });
    await tick();
    const request = http.expectOne((req) => req.url.endsWith('/v1/pc/volume'));
    expect((request.request.body as { level: number }).level).toBe(100);
    request.flush(null, noContent);
    await high;
    await api.volume({});
    http.expectNone((req) => req.url.endsWith('/v1/pc/volume'));
  });

  it('a refusal of the API reaches whoever asked', async () => {
    const { api, http } = setup();
    const sending = api.zoom(2);
    await tick();
    http
      .expectOne((req) => req.url.endsWith('/v1/pc/zoom'))
      .flush(null, { status: 409, statusText: 'Conflict' });
    await expect(sending).rejects.toBeInstanceOf(HttpErrorResponse);
  });
});

describe('PcApi zoom and volume over the direct channel', () => {
  afterEach(() => TestBed.inject(HttpTestingController).verify());

  it('go as the same messages the cloud takes, and never touch the cloud', async () => {
    const { api, http, direct } = setup({ canUse: true });
    await api.zoom(-2);
    await api.volume({ level: 55, muted: false });
    expect(direct.command.mock.calls).toEqual([
      ['pc.pointer.zoom.v1', { steps: -2 }],
      ['pc.volume.v1', { level: 55, muted: false }],
    ]);
    http.expectNone((req) => req.url.includes('/v1/pc/'));
  });

  it('go through the cloud when the agent of the channel did not list them in the ready message', async () => {
    const { api, http, direct } = setup({ canUse: true });
    direct.accepts.mockReturnValue(false);
    const zooming = api.zoom(1);
    await tick();
    const zoom = http.expectOne((req) => req.url.endsWith('/v1/pc/zoom'));
    expect(zoom.request.body).toEqual({ steps: 1, seq: 1, epoch: '3fa9c10d7be2465a' });
    zoom.flush(null, noContent);
    await zooming;
    expect(direct.command).not.toHaveBeenCalled();
  });

  it('go through the cloud when the channel could not carry the command (nothing left)', async () => {
    const { api, http, direct } = setup({ canUse: true });
    direct.command.mockRejectedValueOnce(new DirectNotSent());
    const sending = api.volume({ level: 10 });
    await tick();
    const request = http.expectOne((req) => req.url.endsWith('/v1/pc/volume'));
    request.flush(null, noContent);
    await sending;
  });

  it('an agent that refused or lost the command over the channel is not asked again through the cloud', async () => {
    const { api, http, direct } = setup({ canUse: true });
    direct.command.mockRejectedValueOnce(new HttpErrorResponse({ status: 504 }));
    await expect(api.zoom(2)).rejects.toBeInstanceOf(HttpErrorResponse);
    http.expectNone((req) => req.url.endsWith('/v1/pc/zoom'));
  });
});

describe('PcDirect types for zoom and volume', () => {
  it('only an agent that listed them in the ready message takes them over the channel', () => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    const direct = TestBed.inject(PcDirect);
    expect(direct.accepts('pc.media.v1')).toBe(true);
    expect(direct.accepts('pc.pointer.zoom.v1')).toBe(false);
    expect(direct.accepts('pc.volume.v1')).toBe(false);
  });
});
