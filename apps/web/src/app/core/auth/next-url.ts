// Barra invertida e caracteres de controle: alguns navegadores os normalizam para `//` ou os ignoram.
// eslint-disable-next-line no-control-regex
const UNSAFE = /[\\\u0000-\u001f\u007f]/;

function startsLikeAuthority(path: string): boolean {
  return path.startsWith('//') || path.startsWith('/\\');
}

/**
 * Valida o caminho de retorno (`?next=`) do login. Só passa caminho relativo da própria origem; qualquer coisa
 * que o navegador pudesse resolver para outro destino (`//host`, `/\host`, esquema, codificação disfarçada) é
 * rejeitada, e o login nunca volta para a própria tela de entrada.
 */
export function safeNextUrl(candidate: unknown, origin: string): string | null {
  if (typeof candidate !== 'string' || candidate.length === 0 || candidate.length > 512)
    return null;
  if (!candidate.startsWith('/') || startsLikeAuthority(candidate) || UNSAFE.test(candidate)) {
    return null;
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(candidate);
  } catch {
    return null;
  }
  if (startsLikeAuthority(decoded) || UNSAFE.test(decoded)) return null;

  let resolved: URL;
  try {
    resolved = new URL(candidate, origin);
  } catch {
    return null;
  }
  if (resolved.origin !== new URL(origin).origin) return null;
  if (resolved.pathname === '/entrar' || resolved.pathname.startsWith('/entrar/')) return null;
  return resolved.pathname + resolved.search + resolved.hash;
}
