/**
 * Qual desenho de esqueleto cobre a tela de cada endereço. A MESMA regra vive no seletor em `index.html` (que roda antes de
 * o Angular subir e escolhe o desenho estático do `index.html`): um teste confere as duas contra os mesmos endereços.
 */
export type BootVariant =
  | 'home'
  | 'tv'
  | 'training-today'
  | 'training-list'
  | 'training-progress'
  | 'training-body'
  | 'settings'
  | 'settings-system'
  | 'settings-people'
  | 'settings-audit'
  | 'settings-devices'
  | 'settings-profile'
  | 'settings-appearance'
  | 'detail'
  | 'plain';

/** Telas de entrada, fora da casca dos módulos: nenhum desenho de módulo serviria. */
const PLAIN = /^\/(entrar|convite|boas-vindas|conectar)(\/|$)/;

/** Aceita o caminho puro (`/tv/`) ou um endereço inteiro do roteador (`/tv?painel=apps#x`). */
export function bootVariantFor(path: string): BootVariant {
  const pathname = path.split(/[?#]/, 1)[0] || '/';
  if (pathname === '/' || pathname === '/index.html') return 'home';
  if (/^\/tv(\/|$)/.test(pathname)) return 'tv';
  if (/^\/treino\/(exercicios|rotinas)(\/|$)/.test(pathname)) return 'training-list';
  if (/^\/treino\/progresso(\/|$)/.test(pathname)) return 'training-progress';
  if (/^\/treino\/corpo(\/|$)/.test(pathname)) return 'training-body';
  if (/^\/treino(\/|$)/.test(pathname)) return 'training-today';
  if (/^\/ajustes\/?$/.test(pathname)) return 'settings';
  if (/^\/ajustes\/sistema(\/|$)/.test(pathname)) return 'settings-system';
  if (/^\/ajustes\/pessoas(\/|$)/.test(pathname)) return 'settings-people';
  if (/^\/ajustes\/auditoria(\/|$)/.test(pathname)) return 'settings-audit';
  if (/^\/ajustes\/(dispositivos|aparelhos)(\/|$)/.test(pathname)) return 'settings-devices';
  if (/^\/ajustes\/perfil(\/|$)/.test(pathname)) return 'settings-profile';
  if (/^\/ajustes\/aparencia(\/|$)/.test(pathname)) return 'settings-appearance';
  if (/^\/ajustes\//.test(pathname)) return 'detail';
  if (PLAIN.test(pathname)) return 'plain';
  // Toda rota da casca recebe uma composição conhecida. O genérico não é uma tela do produto
  // e não pode aparecer quando um endereço novo ainda não ganhou desenho específico.
  return 'detail';
}
