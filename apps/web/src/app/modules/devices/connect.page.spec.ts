import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { AuthService } from '../../core/auth/auth.service';
import { SessionState } from '../../core/session/session-state';
import { ConnectPage } from './connect.page';

const WINDOWS =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

describe('ConnectPage', () => {
  const auth = { init: vi.fn() };

  beforeEach(() => {
    auth.init.mockReset().mockResolvedValue(undefined);
    TestBed.configureTestingModule({
      providers: [provideRouter([]), { provide: AuthService, useValue: auth }],
    });
  });
  afterEach(() => vi.restoreAllMocks());

  async function render() {
    const fixture = TestBed.createComponent(ConnectPage);
    await fixture.whenStable();
    return fixture.nativeElement as HTMLElement;
  }

  it('on Windows offers the download, the three steps and the exact buttons of the warnings', async () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(WINDOWS);
    const el = await render();
    const link = el.querySelector<HTMLAnchorElement>('a.download')!;
    expect(link.textContent?.trim()).toBe('Baixar o conector');
    expect(link.getAttribute('href')).toBe('/conectar/conectar-uniover.cmd');
    expect(link.getAttribute('download')).toBe('conectar-uniover.cmd');
    expect(Array.from(el.querySelectorAll('ol > li')).map((li) => li.textContent?.trim())).toEqual([
      'Abra o arquivo baixado',
      'Escaneie o QR da tela com o celular de quem administra',
      'Toque em Permitir na TV',
    ]);
    expect(Array.from(el.querySelectorAll('.warnings strong')).map((s) => s.textContent)).toEqual([
      'Manter',
      'Manter mesmo assim',
      'Mais informações',
      'Executar assim mesmo',
    ]);
  });

  it('without a session offers to sign in and come back, besides the download without an account', async () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(WINDOWS);
    const el = await render();
    expect(auth.init).toHaveBeenCalledOnce();
    expect(el.querySelector('.who')).toBeNull();
    expect(el.querySelector('a.download')).not.toBeNull();
    const login = el.querySelector<HTMLAnchorElement>('.login a')!;
    expect(login.textContent?.trim()).toBe('Entrar');
    expect(login.getAttribute('href')).toBe('/entrar?next=%2Fconectar');
  });

  it('with a session says who it is, keeps the download and hides the sign in', async () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(WINDOWS);
    TestBed.inject(SessionState).setToken('token', 600);
    TestBed.inject(SessionState).setUser({
      id: 'guest-1',
      email: 'g@example.com',
      displayName: 'Raphael',
      role: 'guest',
      permissions: ['module:tv'],
    });
    const el = await render();
    expect(el.querySelector('.who')?.textContent).toContain('Você entrou como Raphael.');
    expect(el.querySelector('.login')).toBeNull();
    expect(el.querySelector('a.download')).not.toBeNull();
    expect(Array.from(el.querySelectorAll('ol > li')).map((li) => li.textContent?.trim())).toEqual([
      'Abra o arquivo baixado',
      'Na janela que abrir, toque em Aprovar neste computador',
      'Toque em Permitir na TV',
    ]);
  });

  it('on other systems only says the connector is for a Windows PC', async () => {
    const el = await render();
    expect(el.querySelector('a.download')).toBeNull();
    expect(el.textContent).toContain('O conector é para PC com Windows. Abra esta página nele.');
  });
});
