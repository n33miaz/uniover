import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { ConnectSheet } from './connect-sheet';

const WINDOWS =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const ANDROID =
  'Mozilla/5.0 (Linux; Android 14; SM-S711B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';

describe('ConnectSheet', () => {
  beforeEach(() => TestBed.configureTestingModule({ providers: [provideRouter([])] }));
  afterEach(() => vi.restoreAllMocks());

  async function render(userAgent = WINDOWS) {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(userAgent);
    const fixture = TestBed.createComponent(ConnectSheet);
    let closed = 0;
    fixture.componentInstance.closed.subscribe(() => closed++);
    await fixture.whenStable();
    const el = fixture.nativeElement as HTMLElement;
    return { fixture, el, closed: () => closed };
  }

  const steps = (el: HTMLElement) =>
    Array.from(el.querySelectorAll('ol > li')).map((li) => li.textContent?.trim());

  it('opens as a modal sheet with the single path: one link on the PC, one QR on the phone', async () => {
    const { el } = await render();
    const dialog = el.querySelector('dialog')!;
    expect(dialog.hasAttribute('open')).toBe(true);
    expect(dialog.getAttribute('aria-labelledby')).toBe('connect-title');
    expect(el.querySelector('h2')?.textContent).toBe('Conectar Este PC');
    expect(steps(el)).toEqual([
      'Baixe e abra o programa neste PC',
      'Aceite o aviso do Windows (só uma vez)',
      'Escaneie com o celular o QR que aparecer',
    ]);
    expect(el.querySelector('.tv-note')?.textContent).toContain('uma vez só');
  });

  it('links to the public page with the browser warnings', async () => {
    const { el } = await render();
    expect(el.querySelector('a.help')?.getAttribute('href')).toBe('/conectar');
  });

  it('on the Windows PC downloads the connector file from the site', async () => {
    const { el } = await render();
    const link = el.querySelector<HTMLAnchorElement>('a.primary')!;
    expect(link.textContent?.trim()).toBe('Baixar Programa');
    expect(link.getAttribute('href')).toBe('/conectar/conectar-uniover.cmd');
    expect(link.getAttribute('download')).toBe('conectar-uniover.cmd');
    expect(el.querySelector('.address')).toBeNull();
  });

  it('on the phone shows the address to open on the PC and copies it', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const { el, fixture } = await render(ANDROID);
    expect(el.querySelector('a.primary')).toBeNull();
    expect(steps(el)[0]).toBe('No PC, abra o endereço abaixo e baixe o programa');
    const url = el.querySelector('code.url')!.textContent!;
    expect(url).toBe(`${location.origin}/conectar`);
    el.querySelector<HTMLButtonElement>('button.copy')!.click();
    await fixture.whenStable();
    expect(writeText).toHaveBeenCalledWith(url);
    expect(el.querySelector('button.copy')?.textContent?.trim()).toBe('Copiado');
    expect(el.querySelector('[role="status"]')?.textContent?.trim()).toBe('Endereço copiado.');
  });

  it('keeps the address on screen when the clipboard is refused', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('negado'));
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const { el, fixture } = await render(ANDROID);
    el.querySelector<HTMLButtonElement>('button.copy')!.click();
    await fixture.whenStable();
    expect(el.querySelector('button.copy')?.textContent?.trim()).toBe('Copiar');
    expect(el.querySelector('code.url')).not.toBeNull();
  });

  it('asks the page to take it away when the user closes it, once', async () => {
    const { el, closed } = await render();
    const button = Array.from(el.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === 'Fechar',
    )!;
    button.click();
    button.click();
    expect(closed()).toBe(1);
  });

  it('closes on Escape without leaving the browser to close it by itself', async () => {
    const { el, closed } = await render();
    const cancel = new Event('cancel', { cancelable: true });
    el.querySelector('dialog')!.dispatchEvent(cancel);
    expect(cancel.defaultPrevented).toBe(true);
    expect(closed()).toBe(1);
  });
});
