import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { AuthService } from '../../../../core/auth/auth.service';
import { SessionState } from '../../../../core/session/session-state';
import { PullApi } from './pull-api';

describe('PullApi', () => {
  let api: PullApi;
  let http: HttpTestingController;
  let token: string | null;
  let renew: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    token = 'token-da-conta-a';
    renew = vi.fn(async () => 'renewed');
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: AuthService, useValue: { accessToken: async () => null, renew } },
        { provide: SessionState, useValue: { bearerOf: () => token } },
      ],
    });
    api = TestBed.inject(PullApi);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('asks for the first page with the limit only', async () => {
    const result = api.fetchPage<string>('/api/v1/training/things', null, 200, 'conta-a');
    const request = http.expectOne('/api/v1/training/things?limit=200');
    expect(request.request.method).toBe('GET');
    expect(request.request.headers.get('Authorization')).toBe('Bearer token-da-conta-a');
    request.flush({ items: ['a'], nextCursor: 'c1' });
    expect(await result).toEqual({ items: ['a'], nextCursor: 'c1' });
  });

  it('sends the cursor, encoded, from the second page on', async () => {
    const result = api.fetchPage<string>('/api/v1/training/things', 'a+b/c=', 50, 'conta-a');
    const request = http.expectOne((req) => req.url === '/api/v1/training/things');
    expect(request.request.params.get('after')).toBe('a+b/c=');
    expect(request.request.params.get('limit')).toBe('50');
    request.flush({ items: [], nextCursor: null });
    await result;
  });

  it('renews after a 401 and retries only with a token of the same account', async () => {
    renew.mockImplementation(async () => {
      token = 'novo-token-da-conta-a';
      return 'renewed';
    });
    const result = api.fetchPage<string>('/api/v1/training/things', null, 20, 'conta-a');
    const first = http.expectOne('/api/v1/training/things?limit=20');
    first.flush(null, { status: 401, statusText: 'Unauthorized' });
    await vi.waitFor(() => expect(renew).toHaveBeenCalledOnce());
    const retry = http.expectOne('/api/v1/training/things?limit=20');
    expect(retry.request.headers.get('Authorization')).toBe('Bearer novo-token-da-conta-a');
    retry.flush({ items: ['a'], nextCursor: null });
    await expect(result).resolves.toEqual({ items: ['a'], nextCursor: null });
  });

  it('does not retry a 401 when renewal yields no token for the account', async () => {
    renew.mockImplementation(async () => {
      token = null;
      return 'renewed';
    });
    const result = api.fetchPage<string>('/api/v1/training/things', null, 20, 'conta-a');
    http.expectOne('/api/v1/training/things?limit=20').flush(null, {
      status: 401,
      statusText: 'Unauthorized',
    });
    await expect(result).rejects.toMatchObject({ name: 'SessionMismatchError' });
    http.expectNone('/api/v1/training/things?limit=20');
  });
});
