/** Evento que anuncia no documento que a folha de estilos principal terminou de carregar (e foi ligada). */
export const STYLES_READY_EVENT = 'uniover:styles-ready';
/** Quanto o app espera a folha de estilos antes de oferecer "Tentar de Novo" (o mesmo prazo do `boot-skeleton.js`). */
export const STYLES_WAIT_MS = 20_000;
/** Quantas aberturas seguidas ficaram sem a folha de estilos (a sessão do navegador guarda). */
export const STYLES_FAILURES_KEY = 'uniover.boot-styles-failures';

/**
 * A folha principal do app chega com `media="print"` (ver `scripts/defer-styles.mjs`) para não bloquear a primeira pintura
 * do esqueleto, e o `boot-skeleton.js` a liga quando ela carrega. Se esse script não rodou a versão nova (cópia antiga no
 * cache do navegador, falha de rede, corrida com o service worker), o app assume o trabalho aqui: sem isso a folha ficaria
 * em `print` para sempre e o app inteiro apareceria sem estilo, sem aviso. Com o script em ação (`data-styles-owner`)
 * não faz nada.
 *
 * Deixa o documento no mesmo estado que o script deixaria: `data-styles` em `pending` até a folha chegar e `ready` depois
 * (a falha oferece "Tentar de Novo" no próprio esqueleto estático e, na segunda abertura seguida sem folha, libera o app sem
 * estilo em vez de repetir o aviso para sempre).
 */
export function adoptBootStyles(doc: Document): void {
  const root = doc.documentElement;
  const link = doc.querySelector<HTMLLinkElement>('link[data-boot-styles]');
  if (
    !link ||
    root.hasAttribute('data-styles-owner') ||
    root.getAttribute('data-styles') === 'ready'
  )
    return;
  const win = doc.defaultView;
  root.setAttribute('data-styles-owner', 'app');
  root.setAttribute('data-styles', 'pending');

  const settle = (unstyled: boolean): void => {
    if (root.getAttribute('data-styles') === 'ready') return;
    link.media = 'all';
    root.setAttribute('data-styles', 'ready');
    if (!unstyled) writeFailures(win, 0);
    doc.dispatchEvent(new Event(STYLES_READY_EVENT));
  };
  const giveUp = (): void => {
    const skeleton = doc.getElementById('boot-skeleton');
    if (!skeleton) return;
    skeleton.setAttribute('data-boot-timeout', 'true');
    const notice = doc.getElementById('boot-timeout');
    if (notice) notice.hidden = false;
  };
  const failed = (): void => {
    if (root.getAttribute('data-styles') === 'ready') return;
    const count = readFailures(win);
    writeFailures(win, count + 1);
    if (count >= 1) settle(true);
    else giveUp();
  };

  if (link.sheet) {
    settle(false);
  } else {
    link.addEventListener('load', () => settle(false));
    link.addEventListener('error', failed);
    win?.setTimeout(giveUp, STYLES_WAIT_MS);
  }
  doc.addEventListener('click', (event) => {
    if ((event.target as Element | null)?.id === 'boot-timeout-retry') retry(doc);
  });
}

function readFailures(win: Window | null): number {
  try {
    return Number(win?.sessionStorage.getItem(STYLES_FAILURES_KEY)) || 0;
  } catch {
    return 0;
  }
}

function writeFailures(win: Window | null, count: number): void {
  try {
    if (count) win?.sessionStorage.setItem(STYLES_FAILURES_KEY, String(count));
    else win?.sessionStorage.removeItem(STYLES_FAILURES_KEY);
  } catch {
    // Sem armazenamento: cada falha vale como a primeira.
  }
}

/** Pede ao service worker uma versão nova (o HTML em cache pode ser de uma que já saiu do ar) e recarrega. */
function retry(doc: Document): void {
  const win = doc.defaultView;
  const go = (): void => doc.location.reload();
  const registrations = win?.navigator.serviceWorker?.getRegistration();
  if (!registrations) {
    go();
    return;
  }
  void registrations.then((registration) => registration?.update()).then(go, go);
  win?.setTimeout(go, 3000);
}
