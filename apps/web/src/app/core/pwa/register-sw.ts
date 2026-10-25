/**
 * Registra o service worker no escopo raiz. Só em produção: em desenvolvimento um SW em cache atrapalha o
 * recarregamento ao vivo e esconde erros. Quem chama trata uma falha sem derrubar o app e pode tentar de novo quando a
 * conexão voltar.
 */
export async function registerServiceWorker(
  win: Window,
  production: boolean,
): Promise<ServiceWorkerRegistration | undefined> {
  if (!production || !('serviceWorker' in win.navigator)) return undefined;
  return win.navigator.serviceWorker.register('/sw.js', { scope: '/' });
}
