import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';
import { setupScreen } from '../shell/screen-test-kit';
import { BodyPage } from './body.page';

describe('BodyPage painel de sinais', () => {
  afterEach(() => vi.unstubAllGlobals());

  async function open() {
    await setupScreen();
    const fixture = TestBed.createComponent(BodyPage);
    await fixture.whenStable();
    fixture.detectChanges();
    return { fixture, el: fixture.nativeElement as HTMLElement };
  }

  it('mostra os sinais na ordem de consulta e mantém o peso como ação principal', async () => {
    const { el } = await open();
    const panel = el.querySelector('.section-content')!;
    const labels = Array.from(
      panel.querySelectorAll('.weight-card, .signal-card, .signal-row'),
    ).map((element) => element.textContent?.replace(/\s+/g, ' ').trim());

    expect(labels).toEqual([
      expect.stringContaining('Peso'),
      expect.stringContaining('Medidas'),
      expect.stringContaining('Gordura Corporal'),
      expect.stringContaining('Avaliações Físicas'),
      expect.stringContaining('Mapa do Corpo'),
      expect.stringContaining('Fotos de Progresso'),
    ]);
    expect(panel.querySelector('.primary-action')?.textContent).toContain('Registrar Peso');
  });

  it('abre registros e fotos pelo painel e anima apenas quando o movimento é permitido', async () => {
    const { fixture, el } = await open();
    const tabs = Array.from(el.querySelectorAll<HTMLButtonElement>('.tabs button'));
    const content = el.querySelector<HTMLElement>('.section-content')!;

    tabs[1].click();
    fixture.detectChanges();
    expect(tabs[1].getAttribute('aria-pressed')).toBe('true');
    expect(content.textContent).toContain('Perfil');
    expect(content.classList.contains('forward')).toBe(true);

    content.dispatchEvent(new Event('animationend'));
    fixture.detectChanges();
    expect(content.classList.contains('forward')).toBe(false);

    tabs[2].click();
    fixture.detectChanges();
    expect(tabs[2].getAttribute('aria-pressed')).toBe('true');
    expect(content.textContent).toContain('Fotos de Progresso');
  });

  it('troca de visão sem animação quando o movimento reduzido é solicitado', async () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true }));
    const { fixture, el } = await open();
    const tabs = el.querySelectorAll<HTMLButtonElement>('.tabs button');
    const content = el.querySelector<HTMLElement>('.section-content')!;

    tabs[1].click();
    fixture.detectChanges();

    expect(content.classList.contains('forward')).toBe(false);
    expect(content.classList.contains('backward')).toBe(false);
  });
});
