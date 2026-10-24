import { TestBed } from '@angular/core/testing';
import { ConnectSheet } from './connect-sheet';

describe('ConnectSheet', () => {
  async function render() {
    const fixture = TestBed.createComponent(ConnectSheet);
    let closed = 0;
    fixture.componentInstance.closed.subscribe(() => closed++);
    await fixture.whenStable();
    const el = fixture.nativeElement as HTMLElement;
    return { fixture, el, closed: () => closed };
  }

  it('opens as a modal sheet with the three steps in order', async () => {
    const { el } = await render();
    const dialog = el.querySelector('dialog')!;
    expect(dialog.hasAttribute('open')).toBe(true);
    expect(dialog.getAttribute('aria-labelledby')).toBe('connect-title');
    expect(el.querySelector('h2')?.textContent).toBe('Conectar este PC');
    expect(Array.from(el.querySelectorAll('ol > li')).map((li) => li.textContent?.trim())).toEqual([
      'Baixar e abrir o conector',
      'Escanear o QR com o celular',
      'Aceitar na TV',
    ]);
  });

  it('downloads the connector file from the site', async () => {
    const { el } = await render();
    const link = el.querySelector<HTMLAnchorElement>('a.primary')!;
    expect(link.textContent?.trim()).toBe('Baixar conector');
    expect(link.getAttribute('href')).toBe('/conectar/conectar-uniover.cmd');
    expect(link.getAttribute('download')).toBe('conectar-uniover.cmd');
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
