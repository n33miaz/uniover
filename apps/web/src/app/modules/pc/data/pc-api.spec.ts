import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { PcApi } from './pc-api';

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
    expect(request.request.body).toEqual({ button: 'LEFT', action: 'DOWN' });
    expect(request.request.keepalive).toBe(false);
    request.flush(null, { status: 204, statusText: 'No Content' });
    await sending;
  });

  it('keepalive is passed to the request, so the browser finishes it even if the page goes away', async () => {
    const sending = api.click('LEFT', 'UP', { keepalive: true });
    const request = http.expectOne((req) => req.url.endsWith('/v1/pc/click'));
    expect(request.request.body).toEqual({ button: 'LEFT', action: 'UP' });
    expect(request.request.keepalive).toBe(true);
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
