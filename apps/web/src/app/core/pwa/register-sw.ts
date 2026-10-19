/**
 * Registra o service worker no escopo raiz. Só em produção: em desenvolvimento um SW em cache atrapalha o
 * recarregamento ao vivo e esconde erros. Falha de registro não derruba o app (a casca só deixa de funcionar offline).
 */
export async function registerServiceWorker(
  win: Window,
  production: boolean,
): Promise<ServiceWorkerRegistration | undefined> {
  if (!production || !('serviceWorker' in win.navigator)) return undefined;
  try {
    return await win.navigator.serviceWorker.register('/sw.js', { scope: '/' });
  } catch {
    return undefined;
  }
}
