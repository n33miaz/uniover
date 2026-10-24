import { TestBed } from '@angular/core/testing';
import { InstallEnvInput } from './install-env';
import { InstallHintSheet } from './install-hint-sheet';
import { INSTALL_ENV, INSTALL_HINT_KEY, InstallHintService } from './install-hint.service';

const WEBKIT = 'AppleWebKit/605.1.15 (KHTML, like Gecko)';
const IPHONE = `Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) ${WEBKIT}`;
const UA = {
  safari: `${IPHONE} Version/17.5 Mobile/15E148 Safari/604.1`,
  chrome: `${IPHONE} CriOS/126.0.6478.153 Mobile/15E148 Safari/604.1`,
  instagram: `${IPHONE} Mobile/21F90 Instagram 340.0.0.28.101 (iPhone14,5; iOS 17_5; pt_BR)`,
  android:
    'Mozilla/5.0 (Linux; Android 14; SM-S711B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
};

const stored = () => JSON.parse(localStorage.getItem(INSTALL_HINT_KEY) ?? 'null');

function holdExitAnimation(dialog: HTMLDialogElement): () => void {
  let finish!: () => void;
  const finished = new Promise<void>((resolve) => (finish = resolve));
  Object.defineProperty(dialog, 'getAnimations', {
    configurable: true,
    value: () => [
      {
        effect: { getComputedTiming: () => ({ iterations: 1 }) },
        finished,
      } as unknown as Animation,
    ],
  });
  return finish;
}

describe('InstallHintSheet', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => {
    vi.restoreAllMocks();
    Reflect.deleteProperty(navigator, 'clipboard');
    Reflect.deleteProperty(document, 'execCommand');
    localStorage.clear();
  });

  async function render(
    env: InstallEnvInput,
    options: { manual?: boolean; beforeCreate?: () => void } = {},
  ) {
    TestBed.configureTestingModule({ providers: [{ provide: INSTALL_ENV, useValue: env }] });
    const hint = TestBed.inject(InstallHintService);
    hint.start();
    options.beforeCreate?.();
    const fixture = TestBed.createComponent(InstallHintSheet);
    fixture.componentRef.setInput('manual', options.manual ?? false);
    let closed = 0;
    fixture.componentInstance.closed.subscribe(() => closed++);
    await fixture.whenStable();
    const el = fixture.nativeElement as HTMLElement;
    const dialog = el.querySelector('dialog')!;
    const buttons = () => Array.from(el.querySelectorAll<HTMLButtonElement>('button'));
    const button = (text: string) => buttons().find((b) => b.textContent?.trim() === text)!;
    const stepTitles = () =>
      Array.from(el.querySelectorAll('.step-title')).map((p) =>
        p.textContent?.replace(/\s+/g, ' ').trim(),
      );
    const numbers = () => Array.from(el.querySelectorAll('.num')).map((n) => n.textContent?.trim());
    return {
      fixture,
      hint,
      el,
      dialog,
      buttons,
      button,
      stepTitles,
      numbers,
      closed: () => closed,
    };
  }

  describe('estrutura comum', () => {
    it('é uma folha modal com título e a frase de que não ocupa espaço', async () => {
      const { el, dialog } = await render({ userAgent: UA.safari });
      expect(dialog.hasAttribute('open')).toBe(true);
      expect(dialog.classList.contains('ui-dialog')).toBe(true);
      expect(dialog.getAttribute('aria-labelledby')).toBe('install-title');
      expect(el.querySelector('h2')?.textContent).toBe('Atalho na tela de início');
      expect(el.querySelector('#install-intro')?.textContent).toContain('é só um atalho');
      expect(el.querySelector('#install-intro')?.textContent).toContain('Não ocupa espaço');
    });

    it('os desenhos são decorativos e os números são escondidos dos leitores de tela (a lista numera)', async () => {
      const { el } = await render({ userAgent: UA.safari });
      expect(el.querySelector('ol')?.getAttribute('role')).toBe('list');
      for (const decor of el.querySelectorAll('.num, .glyph')) {
        expect(decor.getAttribute('aria-hidden')).toBe('true');
      }
    });
  });

  describe('iPhone no Safari', () => {
    it('mostra os três passos do menu Compartilhar, com a dica de rolar a lista', async () => {
      const { el, stepTitles, numbers, buttons } = await render({ userAgent: UA.safari });
      expect(numbers()).toEqual(['1', '2', '3']);
      expect(stepTitles()).toEqual([
        'Toque em Compartilhar',
        'Toque em Adicionar à Tela de Início',
        'Toque em Adicionar',
      ]);
      expect(el.textContent).toContain('role a lista de ações para baixo');
      expect(el.querySelectorAll('.glyph svg')).toHaveLength(3);
      // No Safari há também a confirmação de quem já adicionou o atalho à tela de início.
      expect(buttons().map((b) => b.textContent?.trim())).toEqual([
        'Agora não',
        'Já instalei',
        'Não mostrar de novo',
      ]);
    });

    it('cobre quem veio pelo WhatsApp (o visualizador usa o Safari embutido e não dá para detectar)', async () => {
      const { el } = await render({ userAgent: UA.safari });
      expect(el.querySelector('.note')?.textContent).toContain('WhatsApp');
      expect(el.querySelector('.note')?.textContent).toContain('bússola');
    });

    it('o foco inicial está no primeiro controle', async () => {
      const { button } = await render({ userAgent: UA.safari });
      expect(document.activeElement).toBe(button('Agora não'));
    });
  });

  describe('Android sem pedido nativo', () => {
    it('mostra instruções manuais em vez de esconder a instalação', async () => {
      const { stepTitles, numbers } = await render({ userAgent: UA.android });
      expect(numbers()).toEqual(['1', '2']);
      expect(stepTitles()).toEqual([
        'Abra o menu do navegador',
        'Escolha instalar ou adicionar à tela inicial',
      ]);
    });
  });

  describe('iPhone no Chrome, no Edge ou no Firefox', () => {
    it('traz os mesmos passos, com a ressalva do lugar do Compartilhar e do iOS 16.4', async () => {
      const { el, stepTitles } = await render({ userAgent: UA.chrome });
      expect(stepTitles()).toEqual([
        'Toque em Compartilhar',
        'Toque em Adicionar à Tela de Início',
        'Toque em Adicionar',
      ]);
      expect(el.textContent).toContain(
        'No Chrome e no Edge ele fica na barra de endereço ou no menu',
      );
      expect(el.querySelector('.note')?.textContent).toContain('iOS 16.4');
    });
  });

  describe('app embutido (Instagram, Facebook...)', () => {
    it('o primeiro passo é abrir no Safari, com "Copiar endereço", e os passos do Safari vêm depois', async () => {
      const { stepTitles, numbers, button } = await render({ userAgent: UA.instagram });
      expect(numbers()).toEqual(['1', '2', '3', '4']);
      expect(stepTitles()[0]).toBe('Abra este endereço no Safari');
      expect(stepTitles().slice(1)).toEqual([
        'Toque em Compartilhar',
        'Toque em Adicionar à Tela de Início',
        'Toque em Adicionar',
      ]);
      expect(button('Copiar endereço')).toBeDefined();
      expect(document.activeElement).toBe(button('Copiar endereço'));
    });

    it('copia o endereço sem busca nem fragmento e confirma em uma região de status', async () => {
      const writeText = vi.fn().mockResolvedValue(undefined);
      Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
      const { el, fixture, button } = await render({ userAgent: UA.instagram });
      const status = el.querySelector('[role="status"]')!;
      expect(status.textContent).toBe(''); // a região já existe antes do texto chegar
      button('Copiar endereço').click();
      await fixture.whenStable();
      expect(writeText).toHaveBeenCalledWith(`${location.origin}${location.pathname}`);
      expect(status.textContent).toContain('Endereço copiado');
    });

    it('sem a Clipboard API, copia por seleção num campo da própria folha', async () => {
      const execCommand = vi.fn().mockReturnValue(true);
      Object.defineProperty(document, 'execCommand', { value: execCommand, configurable: true });
      const { el, fixture, button } = await render({ userAgent: UA.instagram });
      button('Copiar endereço').click();
      await fixture.whenStable();
      expect(execCommand).toHaveBeenCalledWith('copy');
      expect(el.querySelector('input.address')?.closest('dialog')).not.toBeNull();
      expect(el.querySelector('[role="status"]')?.textContent).toContain('Endereço copiado');
      expect(el.querySelector('input.address')?.classList.contains('ghost')).toBe(true);
    });

    it('se nada copar, mostra o endereço para copiar na mão', async () => {
      Object.defineProperty(navigator, 'clipboard', {
        value: { writeText: vi.fn().mockRejectedValue(new Error('sem permissão')) },
        configurable: true,
      });
      Object.defineProperty(document, 'execCommand', {
        value: vi.fn().mockReturnValue(false),
        configurable: true,
      });
      const { el, fixture, button } = await render({ userAgent: UA.instagram });
      const field = el.querySelector<HTMLInputElement>('input.address')!;
      expect(field.getAttribute('aria-hidden')).toBe('true');
      expect(field.tabIndex).toBe(-1);
      button('Copiar endereço').click();
      await fixture.whenStable();
      expect(el.querySelector('[role="status"]')?.textContent).toContain('Toque e segure');
      expect(field.classList.contains('ghost')).toBe(false);
      expect(field.hasAttribute('aria-hidden')).toBe(false);
      expect(field.getAttribute('aria-label')).toBe('Endereço do app');
      expect(field.readOnly).toBe(true);
      expect(field.value).toBe(`${location.origin}${location.pathname}`);
    });
  });

  describe('Chromium (instalação nativa)', () => {
    function nativeEvent(outcome: 'accepted' | 'dismissed') {
      const event = new Event('beforeinstallprompt', { cancelable: true });
      Object.assign(event, {
        prompt: vi.fn().mockResolvedValue(undefined),
        userChoice: Promise.resolve({ outcome }),
      });
      return event;
    }

    const renderNative = (outcome: 'accepted' | 'dismissed' = 'accepted') =>
      render(
        { userAgent: UA.android },
        { beforeCreate: () => window.dispatchEvent(nativeEvent(outcome)) },
      );

    it('oferece só o botão Instalar, sem passos', async () => {
      const { el, buttons } = await renderNative();
      expect(el.querySelector('ol')).toBeNull();
      expect(buttons().map((b) => b.textContent?.trim())).toEqual([
        'Instalar',
        'Agora não',
        'Não mostrar de novo',
      ]);
    });

    it('Instalar mostra o pedido do navegador e, aceito, a folha sai', async () => {
      const { button, fixture, dialog, closed } = await renderNative('accepted');
      button('Instalar').click();
      await fixture.whenStable();
      expect(closed()).toBe(1);
      expect(dialog.hasAttribute('open')).toBe(false);
      expect(stored()).toEqual({ installed: true });
    });

    it('com o pedido de outro app, a página recarrega: a folha fica como está, sem erro e sem fechar', async () => {
      const { button, fixture, hint, dialog, closed, el } = await renderNative('accepted');
      const prompt = vi.spyOn(hint, 'prompt').mockResolvedValue('reloading');
      button('Instalar').click();
      await fixture.whenStable();
      expect(prompt).toHaveBeenCalledTimes(1);
      expect(closed()).toBe(0);
      expect(dialog.hasAttribute('open')).toBe(true);
      expect(el.querySelector('[role="alert"]')).toBeNull();
      // Segue ocupada (a página está saindo): um segundo toque não pede outra vez.
      expect(button('Instalar').disabled).toBe(true);
      expect(stored()).toBeNull();
    });

    it('mantém o botão nativo e não troca pelas instruções durante a animação de saída', async () => {
      const { button, fixture, dialog, closed, el } = await renderNative('accepted');
      const finishAnimation = holdExitAnimation(dialog);

      button('Instalar').click();
      await fixture.whenStable();
      expect(dialog.classList.contains('closing')).toBe(true);
      expect(el.querySelector('ol')).toBeNull();
      expect(button('Instalar')).toBeDefined();
      expect(closed()).toBe(0);

      finishAnimation();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(closed()).toBe(1);
    });

    it('recusado no pedido do navegador, a folha sai e o adiamento de 14 dias vale', async () => {
      const { button, fixture, closed } = await renderNative('dismissed');
      button('Instalar').click();
      await fixture.whenStable();
      expect(closed()).toBe(1);
      expect(stored().dismissedAt).toEqual(expect.any(Number));
    });
  });

  describe('as saídas', () => {
    it('"Agora não" adia por 14 dias, desce a folha e avisa uma única vez', async () => {
      const { button, fixture, dialog, closed } = await render({ userAgent: UA.safari });
      button('Agora não').click();
      button('Agora não').click(); // toque repetido
      await fixture.whenStable();
      expect(closed()).toBe(1);
      expect(dialog.hasAttribute('open')).toBe(false); // close() devolve o foco a quem abriu
      expect(dialog.classList.contains('closing')).toBe(true);
      expect(stored().dismissedAt).toEqual(expect.any(Number));
      expect(stored().never).toBeUndefined();
    });

    it('"Não mostrar de novo" é lembrado para sempre', async () => {
      const { button, fixture, closed } = await render({ userAgent: UA.safari });
      button('Não mostrar de novo').click();
      await fixture.whenStable();
      expect(closed()).toBe(1);
      expect(stored()).toEqual({ never: true });
    });

    it('no iOS, "Já instalei" confirma e impede a folha automática em sessões futuras', async () => {
      const { button, fixture, closed, hint } = await render({ userAgent: UA.safari });
      button('Já instalei').click();
      await fixture.whenStable();
      expect(closed()).toBe(1);
      expect(hint.mode()).toBe('none');
      expect(stored()).toEqual({ installed: true });

      TestBed.resetTestingModule();
      TestBed.configureTestingModule({
        providers: [{ provide: INSTALL_ENV, useValue: { userAgent: UA.safari } }],
      });
      expect(TestBed.inject(InstallHintService).autoOpenAllowed()).toBe(false);
    });

    it('mantém o conteúdo do iOS visível até terminar a animação de saída', async () => {
      const { button, fixture, dialog, closed, el } = await render({ userAgent: UA.safari });
      const finishAnimation = holdExitAnimation(dialog);

      button('Já instalei').click();
      fixture.detectChanges();
      expect(dialog.classList.contains('closing')).toBe(true);
      expect(el.querySelector('.steps')).not.toBeNull();
      expect(button('Já instalei')).toBeDefined();
      expect(closed()).toBe(0);

      finishAnimation();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(closed()).toBe(1);
    });

    it('Esc vale como "Agora não": o evento cancel é barrado (quem tira a folha é o hospedeiro) e a dica adia', async () => {
      const { dialog, fixture, closed } = await render({ userAgent: UA.safari });
      const cancel = new Event('cancel', { cancelable: true });
      dialog.dispatchEvent(cancel);
      await fixture.whenStable();
      expect(cancel.defaultPrevented).toBe(true);
      expect(closed()).toBe(1);
      expect(stored().dismissedAt).toEqual(expect.any(Number));
    });

    it('aberta pela pessoa (manual): só "Fechar", e fechar não adia nem apaga a dica automática', async () => {
      const { buttons, button, fixture, closed } = await render(
        { userAgent: UA.safari },
        { manual: true },
      );
      expect(buttons().map((b) => b.textContent?.trim())).toEqual(['Fechar']);
      button('Fechar').click();
      await fixture.whenStable();
      expect(closed()).toBe(1);
      expect(stored()).toBeNull();
    });

    it('Esc na folha aberta pela pessoa também só fecha', async () => {
      const { dialog, fixture, closed } = await render({ userAgent: UA.safari }, { manual: true });
      dialog.dispatchEvent(new Event('cancel', { cancelable: true }));
      await fixture.whenStable();
      expect(closed()).toBe(1);
      expect(stored()).toBeNull();
    });
  });
});
