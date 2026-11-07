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
