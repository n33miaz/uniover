import { HttpErrorResponse, provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { PcApi } from './pc-api';
import { DirectNotSent, PcDirect } from './pc-direct';

/** O canal direto de mentira: o teste diz se pode levar o comando e o que ele responde. */
function setup() {
  let cloudSeq = 0;
  const direct = {
    canUse: vi.fn(() => true),
    nextCloudSeq: vi.fn(() => ++cloudSeq),
    cloudEpoch: '3fa9c10d7be2465a',
    command: vi.fn<(type: string, body: Record<string, unknown>) => Promise<void>>(() =>
      Promise.resolve(),
    ),
    sendPointer: vi.fn<(dx: number, dy: number, sx: number, sy: number) => void>(),
    trackCloud: vi.fn(<T>(call: Promise<T>) => call),
  };
  TestBed.configureTestingModule({
    providers: [
      provideHttpClient(),
      provideHttpClientTesting(),
      { provide: PcDirect, useValue: direct },
    ],
  });
  return {
    api: TestBed.inject(PcApi),
    http: TestBed.inject(HttpTestingController),
    direct,
  };
}

const noContent = { status: 204, statusText: 'No Content' };
/** Deixa a chamada decidir o caminho (ela espera o canal antes de cair para a nuvem). */
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('PcApi over the direct channel', () => {
  afterEach(() => TestBed.inject(HttpTestingController).verify());

  it.each<[string, (api: PcApi) => Promise<void>, string, Record<string, unknown>]>([
    [
      'click',
      (api) => api.click('LEFT', 'DOWN'),
      'pc.click.v1',
      { button: 'LEFT', action: 'DOWN' },
    ],
    ['plain click', (api) => api.click('RIGHT'), 'pc.click.v1', { button: 'RIGHT' }],
    ['plain key', (api) => api.key('ENTER'), 'pc.key.v1', { key: 'ENTER' }],
    [
      'key with modifiers',
      (api) => api.key('C', ['CTRL']),
      'pc.key.v1',
      { key: 'C', modifiers: ['CTRL'] },
    ],
    [
      'repeated key',
      (api) => api.key('BACKSPACE', [], { repeat: 5 }),
      'pc.key.v2',
      { key: 'BACKSPACE', repeat: 5 },
    ],
    [
      'held modifier',
      (api) => api.key('ALT', [], { action: 'DOWN' }),
      'pc.key.v2',
      { key: 'ALT', action: 'DOWN' },
    ],
    ['a v2-only key', (api) => api.key('INSERT'), 'pc.key.v2', { key: 'INSERT' }],
    ['modifier release', (api) => api.keyRelease('ALT'), 'pc.key.v2', { key: 'ALT', action: 'UP' }],
    ['text', (api) => api.text('olá'), 'pc.text.v1', { text: 'olá' }],
    ['plain text edit', (api) => api.edit({ text: 'olá' }), 'pc.text.v1', { text: 'olá' }],
    [
      'edit that erases, types and presses a key',
      (api) => api.edit({ erase: 3, text: 'olá', key: 'ENTER' }),
      'pc.text.v2',
      { erase: 3, text: 'olá', key: 'ENTER' },
    ],
    ['edit that only erases', (api) => api.edit({ erase: 7 }), 'pc.text.v2', { erase: 7 }],
    [
      'edit that only presses a key',
      (api) => api.edit({ key: 'TAB' }),
      'pc.text.v2',
      { key: 'TAB' },
    ],
    [
      'click with a modifier',
      (api) => api.click('LEFT', undefined, { modifiers: ['CTRL'] }),
      'pc.click.v2',
      { button: 'LEFT', modifiers: ['CTRL'] },
    ],
    [
      'second tap of a double tap, with the gap',
      (api) => api.click('LEFT', undefined, { gapMs: 140 }),
      'pc.click.v2',
      { button: 'LEFT', gapMs: 140 },
    ],
    [
      'click with an empty modifier list and no gap is still the v1',
      (api) => api.click('LEFT', undefined, { modifiers: [], gapMs: 0 }),
      'pc.click.v1',
      { button: 'LEFT' },
    ],
    ['media', (api) => api.media('MUTE'), 'pc.media.v1', { action: 'MUTE' }],
    [
      'media with steps',
      (api) => api.media('VOLUME_UP', 3),
      'pc.media.v1',
      { action: 'VOLUME_UP', steps: 3 },
    ],
  ])('%s goes through the channel and never touches the cloud', async (_name, call, type, body) => {
    const { api, direct, http } = setup();
    await call(api);

    expect(direct.command).toHaveBeenCalledWith(type, body);
    http.expectNone(() => true);
  });

  it('the pointer goes as totals through the channel, with no request', async () => {
    const { api, direct, http } = setup();
    await api.pointer(10, -5, 0, 120, 7);

    expect(direct.sendPointer).toHaveBeenCalledWith(10, -5, 0, 120);
    http.expectNone(() => true);
  });

  it('the heartbeat (a still pointer) also goes through the channel', async () => {
    const { api, direct } = setup();
    await api.pointer(0, 0);

    expect(direct.sendPointer).toHaveBeenCalledWith(0, 0, 0, 0);
  });

  it('power and favorites only exist through the cloud, even with the channel open', async () => {
    const { api, direct, http } = setup();
    const power = api.power('SHUTDOWN', true);
    const launch = api.launch('navegador');
    http.expectOne((r) => r.url.endsWith('/v1/pc/power')).flush(null, noContent);
    http.expectOne((r) => r.url.endsWith('/v1/pc/apps/navegador/launch')).flush(null, noContent);
    await Promise.all([power, launch]);

    expect(direct.command).not.toHaveBeenCalled();
    expect(direct.trackCloud).toHaveBeenCalledTimes(2);
  });

  it('keepalive requests (the dying page) always go by the cloud, which finishes them after it', async () => {
    const { api, direct, http } = setup();
    const click = api.click('LEFT', 'UP', { keepalive: true });
    const release = api.keyRelease('ALT', { keepalive: true });
    const clickRequest = http.expectOne((r) => r.url.endsWith('/v1/pc/click'));
    const releaseRequest = http.expectOne((r) => r.url.endsWith('/v1/pc/key/release'));
    expect(clickRequest.request.keepalive).toBe(true);
    expect(releaseRequest.request.keepalive).toBe(true);
    clickRequest.flush(null, noContent);
    releaseRequest.flush(null, noContent);
    await Promise.all([click, release]);

    expect(direct.command).not.toHaveBeenCalled();
  });
});

describe('PcApi when the channel cannot take the command', () => {
  afterEach(() => TestBed.inject(HttpTestingController).verify());

  it('uses the cloud when the channel is closed or the cloud still has requests in flight', async () => {
    const { api, direct, http } = setup();
    direct.canUse.mockReturnValue(false);
    const sending = api.key('ENTER');
    await tick();
    http.expectOne((r) => r.url.endsWith('/v1/pc/key')).flush(null, noContent);
    await sending;

    expect(direct.command).not.toHaveBeenCalled();
    expect(direct.trackCloud).toHaveBeenCalledTimes(1);
  });

  it('a request that goes by the cloud carries the next number of the shared counter', async () => {
    const { api, direct, http } = setup();
    direct.canUse.mockReturnValue(false);
    const first = api.click('LEFT');
    await tick();
    const click = http.expectOne((r) => r.url.endsWith('/v1/pc/click'));
    click.flush(null, noContent);
    await first;
    const second = api.text('olá');
    await tick();
    const text = http.expectOne((r) => r.url.endsWith('/v1/pc/text'));
    text.flush(null, noContent);
    await second;

    expect(click.request.body).toEqual({ button: 'LEFT', seq: 1, epoch: '3fa9c10d7be2465a' });
    expect(text.request.body).toEqual({ text: 'olá', seq: 2, epoch: '3fa9c10d7be2465a' });
  });

  it('a command that goes by the channel takes no number from the cloud counter', async () => {
    const { api, direct } = setup();

    await api.click('LEFT', 'DOWN');

    expect(direct.command).toHaveBeenCalledTimes(1);
    expect(direct.nextCloudSeq).not.toHaveBeenCalled();
  });

  it('a pointer with the channel unavailable goes by the cloud with its sequence number', async () => {
    const { api, direct, http } = setup();
    direct.canUse.mockReturnValue(false);
    const sending = api.pointer(3, 4, 0, 0, 9);
    const request = http.expectOne((r) => r.url.endsWith('/v1/pc/pointer'));
    expect(request.request.body).toEqual({ dx: 3, dy: 4, seq: 9 });
    request.flush(null, noContent);
    await sending;

    expect(direct.sendPointer).not.toHaveBeenCalled();
  });

  it('a command that did not leave (the channel closed first) is sent by the cloud, once', async () => {
    const { api, direct, http } = setup();
    direct.command.mockRejectedValueOnce(new DirectNotSent());
    const sending = api.text('olá');
    await tick();
    http.expectOne((r) => r.url.endsWith('/v1/pc/text')).flush(null, noContent);
    await sending;

    expect(direct.command).toHaveBeenCalledTimes(1);
  });

  it('a pointer that did not leave (the channel closed first) is sent by the cloud', async () => {
    const { api, direct, http } = setup();
    direct.sendPointer.mockImplementationOnce(() => {
      throw new DirectNotSent();
    });
    const sending = api.pointer(2, 2);
    http.expectOne((r) => r.url.endsWith('/v1/pc/pointer')).flush(null, noContent);
    await sending;
  });

  it('a command sent on the channel with no answer is a failure, and the cloud is NOT used (no duplicate)', async () => {
    const { api, direct, http } = setup();
    direct.command.mockRejectedValueOnce(new HttpErrorResponse({ status: 504 }));

    const error = (await api.click('LEFT', 'DOWN').catch((e: unknown) => e)) as HttpErrorResponse;

    expect(error.status).toBe(504);
    http.expectNone(() => true);
    expect(direct.trackCloud).not.toHaveBeenCalled();
  });

  it('an agent refusal on the channel reaches the caller as the same error shape', async () => {
    const { api, direct, http } = setup();
    direct.command.mockRejectedValueOnce(new HttpErrorResponse({ status: 429 }));

    const error = (await api.key('A').catch((e: unknown) => e)) as HttpErrorResponse;

    expect(error.status).toBe(429);
    http.expectNone(() => true);
  });

  it('counts the cloud request as in flight until it ends, even when it fails', async () => {
    const { api, direct, http } = setup();
    direct.canUse.mockReturnValue(false);
    const sending = api.media('MUTE');
    await tick();
    http
      .expectOne((r) => r.url.endsWith('/v1/pc/media'))
      .flush({ title: 'x' }, { status: 503, statusText: 'Service Unavailable' });

    await expect(sending).rejects.toBeInstanceOf(HttpErrorResponse);
    expect(direct.trackCloud).toHaveBeenCalledTimes(1);
  });
});
