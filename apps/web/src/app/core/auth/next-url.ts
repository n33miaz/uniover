// Barra invertida e caracteres de controle: alguns navegadores os normalizam para `//` ou os ignoram.
// eslint-disable-next-line no-control-regex
const UNSAFE = /[\\\u0000-\u001f\u007f]/;

function startsLikeAuthority(path: string): boolean {
  return path.startsWith('//') || path.startsWith('/\\');
}

/** Telas de entrada que nunca servem de destino: voltar a elas depois de entrar (ou de dizer o nome) seria um laço. */
const ENTRY_PATHS = ['/entrar', '/boas-vindas'];

/**
 * A exceção: a tela em que o celular confirma a entrada de um computador pelo QR mora sob `/entrar`, mas exige sessão. Quem
 * a abre sem ter entrado passa pelo login e precisa voltar a ela (com o `?codigo=`), senão perderia o QR.
 */
const QR_APPROVE_PATH = '/entrar/qr';

/**
 * Valida o caminho de retorno (`?next=`) do login e da pergunta do nome. Só passa caminho relativo da própria
 * origem; qualquer coisa que o navegador pudesse resolver para outro destino (`//host`, `/\host`, esquema,
 * codificação disfarçada) é rejeitada, e o retorno nunca leva a uma das telas de entrada.
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
  if (
    resolved.pathname !== QR_APPROVE_PATH &&
    ENTRY_PATHS.some(
      (path) => resolved.pathname === path || resolved.pathname.startsWith(path + '/'),
    )
  )
    return null;
  return resolved.pathname + resolved.search + resolved.hash;
}
