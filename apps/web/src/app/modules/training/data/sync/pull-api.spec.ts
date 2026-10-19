import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { PullApi } from './pull-api';

describe('PullApi', () => {
  let api: PullApi;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    api = TestBed.inject(PullApi);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('asks for the first page with the limit only', async () => {
    const result = api.fetchPage<string>('/api/v1/training/things', null, 200);
    const request = http.expectOne('/api/v1/training/things?limit=200');
    expect(request.request.method).toBe('GET');
    request.flush({ items: ['a'], nextCursor: 'c1' });
    expect(await result).toEqual({ items: ['a'], nextCursor: 'c1' });
  });

  it('sends the cursor, encoded, from the second page on', async () => {
    const result = api.fetchPage<string>('/api/v1/training/things', 'a+b/c=', 50);
    const request = http.expectOne((req) => req.url === '/api/v1/training/things');
    expect(request.request.params.get('after')).toBe('a+b/c=');
    expect(request.request.params.get('limit')).toBe('50');
    request.flush({ items: [], nextCursor: null });
    await result;
  });
});
