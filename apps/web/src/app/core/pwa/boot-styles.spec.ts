import {
  STYLES_FAILURES_KEY,
  STYLES_READY_EVENT,
  STYLES_WAIT_MS,
  adoptBootStyles,
} from './boot-styles';

describe('adoptBootStyles (the app takes over the main stylesheet when the boot script did not)', () => {
  let link: HTMLLinkElement;
  let skeleton: HTMLElement;
  let notice: HTMLElement;
  const root = document.documentElement;
  /** Dá ao link uma folha de verdade (o navegador de teste não baixa nada), como no instante em que a folha carrega. */
  const finishLoading = (): void => {
    Object.defineProperty(link, 'sheet', { value: { cssRules: [{}] }, configurable: true });
    link.dispatchEvent(new Event('load'));
  };

  beforeEach(() => {
    link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = 'styles-TESTE.css';
    link.media = 'print';
    link.setAttribute('data-boot-styles', '');
    document.head.append(link);
    skeleton = document.createElement('div');
    skeleton.id = 'boot-skeleton';
    notice = document.createElement('div');
    notice.id = 'boot-timeout';
    notice.hidden = true;
    document.body.append(skeleton, notice);
    sessionStorage.removeItem(STYLES_FAILURES_KEY);
  });

  afterEach(() => {
    vi.useRealTimers();
    link.remove();
    skeleton.remove();
    notice.remove();
    root.removeAttribute('data-styles');
    root.removeAttribute('data-styles-owner');
    sessionStorage.removeItem(STYLES_FAILURES_KEY);
  });

  it('does nothing when the boot script already owns the stylesheet, or when there is nothing to adopt', () => {
    root.setAttribute('data-styles-owner', 'boot');
    root.setAttribute('data-styles', 'pending');
    adoptBootStyles(document);
    expect(link.media).toBe('print');
    expect(root.getAttribute('data-styles-owner')).toBe('boot');

    root.removeAttribute('data-styles-owner');
    link.removeAttribute('data-boot-styles');
    adoptBootStyles(document);
    expect(root.hasAttribute('data-styles-owner')).toBe(false);
  });

  it('turns the stylesheet on and announces it when it loads, so the app is never left unstyled', () => {
    const ready = vi.fn();
    document.addEventListener(STYLES_READY_EVENT, ready);
    adoptBootStyles(document);
    expect(root.getAttribute('data-styles')).toBe('pending');
    expect(root.getAttribute('data-styles-owner')).toBe('app');
    expect(link.media).toBe('print');

    finishLoading();
    expect(link.media).toBe('all');
    expect(root.getAttribute('data-styles')).toBe('ready');
    expect(ready).toHaveBeenCalledTimes(1);
    finishLoading();
    expect(ready).toHaveBeenCalledTimes(1);
    document.removeEventListener(STYLES_READY_EVENT, ready);
  });

  it('keeps the skeleton and offers a retry when the stylesheet fails, and when it never answers', () => {
    vi.useFakeTimers();
    adoptBootStyles(document);
    link.dispatchEvent(new Event('error'));
    expect(root.getAttribute('data-styles')).toBe('pending');
    expect(link.media).toBe('print');
    expect(skeleton.getAttribute('data-boot-timeout')).toBe('true');
    expect(notice.hidden).toBe(false);
    expect(sessionStorage.getItem(STYLES_FAILURES_KEY)).toBe('1');

    // Sem resposta nenhuma: o prazo também devolve o aviso.
    notice.hidden = true;
    skeleton.removeAttribute('data-boot-timeout');
    vi.advanceTimersByTime(STYLES_WAIT_MS);
    expect(notice.hidden).toBe(false);
  });

  it('on the second failure in a row it lets the app through unstyled instead of repeating the notice forever', () => {
    sessionStorage.setItem(STYLES_FAILURES_KEY, '1');
    const ready = vi.fn();
    document.addEventListener(STYLES_READY_EVENT, ready);
    adoptBootStyles(document);
    link.dispatchEvent(new Event('error'));
    expect(root.getAttribute('data-styles')).toBe('ready');
    expect(ready).toHaveBeenCalledTimes(1);
    expect(notice.hidden).toBe(true);
    // A falha continua contada: só uma abertura com a folha de verdade zera o contador.
    expect(sessionStorage.getItem(STYLES_FAILURES_KEY)).toBe('2');
    document.removeEventListener(STYLES_READY_EVENT, ready);
  });

  it('forgets the failures once the stylesheet loads', () => {
    sessionStorage.setItem(STYLES_FAILURES_KEY, '1');
    adoptBootStyles(document);
    finishLoading();
    expect(sessionStorage.getItem(STYLES_FAILURES_KEY)).toBeNull();
  });
});
