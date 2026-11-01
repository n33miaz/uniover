/**
 * Qual desenho de esqueleto cobre a tela de cada endereço. A MESMA regra vive em `public/boot-route.js` (que roda antes de
 * o Angular subir e escolhe o desenho estático do `index.html`): um teste confere as duas contra os mesmos endereços.
 */
export type BootVariant = 'home' | 'tv' | 'training' | 'settings' | 'detail' | 'plain' | 'generic';

/** Telas de entrada, fora da casca dos módulos: nenhum desenho de módulo serviria. */
const PLAIN = /^\/(entrar|convite|boas-vindas|conectar)(\/|$)/;

/** Aceita o caminho puro (`/tv/`) ou um endereço inteiro do roteador (`/tv?painel=apps#x`). */
export function bootVariantFor(path: string): BootVariant {
  const pathname = path.split(/[?#]/, 1)[0] || '/';
  if (pathname === '/' || pathname === '/index.html') return 'home';
  if (/^\/tv(\/|$)/.test(pathname)) return 'tv';
  if (/^\/treino(\/|$)/.test(pathname)) return 'training';
  if (/^\/ajustes\/?$/.test(pathname)) return 'settings';
  if (/^\/ajustes\//.test(pathname)) return 'detail';
  if (PLAIN.test(pathname)) return 'plain';
  return 'generic';
}
