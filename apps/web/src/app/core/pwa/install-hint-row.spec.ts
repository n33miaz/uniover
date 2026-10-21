import { TestBed } from '@angular/core/testing';
import { InstallEnvInput } from './install-env';
import { InstallHintRow } from './install-hint-row';
import { INSTALL_ENV, InstallHintService } from './install-hint.service';

const WEBKIT = 'AppleWebKit/605.1.15 (KHTML, like Gecko)';
const SAFARI = `Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) ${WEBKIT} Version/17.5 Mobile/15E148 Safari/604.1`;
const ANDROID =
  'Mozilla/5.0 (Linux; Android 14; SM-S711B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36';
const DESKTOP =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

describe('InstallHintRow', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  async function render(env: InstallEnvInput, tile = false) {
    TestBed.configureTestingModule({ providers: [{ provide: INSTALL_ENV, useValue: env }] });
    const hint = TestBed.inject(InstallHintService);
    hint.start();
    const fixture = TestBed.createComponent(InstallHintRow);
    fixture.componentRef.setInput('tile', tile);
    await fixture.whenStable();
    const host = fixture.nativeElement as HTMLElement;
    return { fixture, hint, host, button: () => host.querySelector('button') };
  }

  it('mostra a linha no iPhone, com o título e o que o atalho é', async () => {
    const { host, button } = await render({ userAgent: SAFARI });
    expect(host.hidden).toBe(false);
    expect(button()?.querySelector('.ui-row-title')?.textContent).toBe(
      'Adicionar à tela de início',
    );
    expect(button()?.querySelector('.ui-row-sub')?.textContent).toContain('não ocupa espaço');
    expect(button()?.getAttribute('type')).toBe('button');
  });

  it('esconde o host inteiro quando não há o que oferecer (para não deixar um vão no contêiner)', async () => {
    const { host } = await render({ userAgent: DESKTOP });
    expect(host.hidden).toBe(true);
    expect(host.hasAttribute('hidden')).toBe(true);
  });

  it('já instalado (standalone): a linha some', async () => {
    const { host } = await render({ userAgent: SAFARI, standalone: true });
    expect(host.hidden).toBe(true);
  });

  it('no Android aparece quando o navegador entrega o pedido de instalação e some quando instala', async () => {
    const { fixture, host } = await render({ userAgent: ANDROID });
    expect(host.hidden).toBe(true);
    window.dispatchEvent(new Event('beforeinstallprompt', { cancelable: true }));
    await fixture.whenStable();
    expect(host.hidden).toBe(false);
    window.dispatchEvent(new Event('appinstalled'));
    await fixture.whenStable();
    expect(host.hidden).toBe(true);
  });

  it('tocar abre a folha pela pessoa, mesmo depois de "Não mostrar de novo"', async () => {
    const { hint, button } = await render({ userAgent: SAFARI });
    hint.never();
    button()!.click();
    expect(hint.sheet()).toBe('manual');
  });

  it('o ladrilho de ícone é opcional e decorativo', async () => {
    const plain = await render({ userAgent: SAFARI });
    expect(plain.host.querySelector('.ui-tile')).toBeNull();
    TestBed.resetTestingModule();
    const withTile = await render({ userAgent: SAFARI }, true);
    const tile = withTile.host.querySelector('.ui-tile');
    expect(tile?.getAttribute('aria-hidden')).toBe('true');
    expect(tile?.querySelectorAll('path').length).toBeGreaterThan(0);
  });
});
