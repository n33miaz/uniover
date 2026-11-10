import { HttpClient, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { ClientTelemetry } from '../telemetry/client-telemetry';
import { telemetryInterceptor } from '../telemetry/telemetry.interceptor';
import { ConnectivityBanner } from './connectivity-banner';
import { connectivityInterceptor } from './connectivity.interceptor';
import { ConnectivityService } from './connectivity.service';
import { resumeRetryInterceptor } from './resume-retry.interceptor';

/**
 * O que o dono pediu: ao voltar ao app nenhum aviso aparece, esteja ou não tudo conectado. Aqui ficam as peças reais juntas
 * (carência, repetição silenciosa, conectividade, faixa do topo e telemetria) e se vê a tela, não cada peça.
 */
describe('coming back to the app', () => {
  let http: HttpClient;
  let backend: HttpTestingController;
  let fetchMock: ReturnType<typeof vi.fn>;
  let onLine: ReturnType<typeof vi.spyOn>;

  const setVisibility = (state: 'visible' | 'hidden') => {
    Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  };
  const noResponse = () => ({ status: 0, statusText: '' });

  function render() {
    const fixture = TestBed.createComponent(ConnectivityBanner);
    fixture.detectChanges();
    return {
      fixture,
      banner: () => (fixture.nativeElement as HTMLElement).querySelector('.banner'),
    };
  }

  beforeEach(() => {
    vi.useFakeTimers();
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    onLine = vi.spyOn(window.navigator, 'onLine', 'get').mockReturnValue(true);
    fetchMock = vi.fn().mockResolvedValue({ ok: true });
    window.fetch = fetchMock as unknown as typeof window.fetch;
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(
          withInterceptors([telemetryInterceptor, connectivityInterceptor, resumeRetryInterceptor]),
        ),
        provideHttpClientTesting(),
      ],
    });
    http = TestBed.inject(HttpClient);
    backend = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    Reflect.deleteProperty(document, 'visibilityState');
  });

  it('with the network fine, the sockets the system dropped cost nothing: reads are redone and nothing is shown', async () => {
    const connectivity = TestBed.inject(ConnectivityService);
    const telemetry = TestBed.inject(ClientTelemetry);
    const record = vi.spyOn(telemetry, 'record');
    const { banner } = render();

    setVisibility('hidden');
    setVisibility('visible');
    // Várias leituras saem juntas na volta (TV, PC, Treino, casa, sessão) e a primeira de cada uma cai sem resposta.
    const results: string[] = [];
    for (const path of ['/api/v1/tv/state', '/api/v1/pc/status', '/api/v1/training/today']) {
      http.get(path).subscribe({
        next: () => results.push(`${path} ok`),
        error: () => results.push(`${path} erro`),
      });
    }
    for (const request of backend.match(() => true)) {
      request.error(new ProgressEvent('error'), noResponse());
    }
    expect(banner()).toBeNull();
    expect(connectivity.serverState()).toBe('ok');

    await vi.advanceTimersByTimeAsync(900);
    for (const request of backend.match(() => true)) request.flush({});
    await vi.advanceTimersByTimeAsync(5_000);
    TestBed.tick();

    expect(results.sort()).toEqual([
      '/api/v1/pc/status ok',
      '/api/v1/training/today ok',
      '/api/v1/tv/state ok',
    ]);
    expect(banner()).toBeNull();
    expect(connectivity.serverState()).toBe('ok');
    expect(connectivity.online()).toBe(true);
    // Nada foi nem enviado à telemetria: as falhas foram salvas pela repetição.
    expect(record).not.toHaveBeenCalled();
    // E nenhuma checagem de saúde saiu sem necessidade.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('the browser saying "offline" for an instant on the way back shows nothing either', async () => {
    const connectivity = TestBed.inject(ConnectivityService);
    const { banner } = render();
    setVisibility('hidden');
    setVisibility('visible');
    window.dispatchEvent(new Event('offline'));
    TestBed.tick();
    expect(banner()).toBeNull();
    expect(connectivity.online()).toBe(true);
    await vi.advanceTimersByTimeAsync(5_000);
    TestBed.tick();
    expect(banner()).toBeNull();
    expect(connectivity.serverState()).toBe('ok');
  });

  it('if the server really is down, the banner comes only after the grace period and one failed health check', async () => {
    fetchMock.mockRejectedValue(new Error('fora do ar'));
    const connectivity = TestBed.inject(ConnectivityService);
    const { banner } = render();
    setVisibility('hidden');
    setVisibility('visible');
    http.get('/api/v1/tv/state').subscribe({ error: () => undefined });

    // Falha, repete em silêncio (2 vezes) e segue falhando.
    for (let attempt = 0; attempt < 3; attempt++) {
      for (const request of backend.match(() => true)) {
        request.error(new ProgressEvent('error'), noResponse());
      }
      await vi.advanceTimersByTimeAsync(900);
    }
    TestBed.tick();
    expect(banner()).toBeNull();

    await vi.advanceTimersByTimeAsync(2_000);
    TestBed.tick();
    expect(connectivity.serverState()).toBe('waking');
    expect(banner()?.textContent).toContain('Acordando o servidor');
  });

  it('a command that fails on the way back is not repeated by itself and the caller still hears about it', async () => {
    const connectivity = TestBed.inject(ConnectivityService);
    const { banner } = render();
    setVisibility('hidden');
    setVisibility('visible');
    const error = vi.fn();
    http.post('/api/v1/tv/key', { key: 'OK' }).subscribe({ error });
    backend.expectOne('/api/v1/tv/key').error(new ProgressEvent('error'), noResponse());
    await vi.advanceTimersByTimeAsync(2_000);
    backend.expectNone('/api/v1/tv/key');
    expect(error).toHaveBeenCalledTimes(1);
    // O aviso do comando é de quem o deu (a TV, o PC); a faixa do topo segue calada na carência.
    TestBed.tick();
    expect(banner()).toBeNull();
    expect(connectivity.serverState()).toBe('ok');
  });

  it('truly offline from the start is still said plainly: that is not a return', () => {
    TestBed.resetTestingModule();
    onLine.mockReturnValue(false);
    TestBed.configureTestingModule({});
    const connectivity = TestBed.inject(ConnectivityService);
    const { banner } = render();
    expect(connectivity.serverState()).toBe('offline');
    expect(banner()?.textContent).toContain('Sem conexão');
  });
});
