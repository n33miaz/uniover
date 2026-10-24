import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { ConnectPage } from './connect.page';

const WINDOWS =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

describe('ConnectPage', () => {
  beforeEach(() => TestBed.configureTestingModule({ providers: [provideRouter([])] }));
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

  it('on other systems only says the connector is for a Windows PC', async () => {
    const el = await render();
    expect(el.querySelector('a.download')).toBeNull();
    expect(el.textContent).toContain('O conector é para PC com Windows. Abra esta página nele.');
  });
});
