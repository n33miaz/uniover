/**
 * Guarda dos mocks de API dos testes e2e: estas escritas do site novo sempre levam `Idempotency-Key` (um UUID). Assim um
 * cliente que esqueça o cabeçalho quebra o teste, mesmo enquanto a API aceita clientes antigos sem ele. Caminhos depois de
 * `/api/v1/`.
 */
const ID = '[^/]+';
const ROUTES: readonly { readonly method: string; readonly path: RegExp }[] = [
  { method: 'PATCH', path: /^identity\/me$/ },
  { method: 'POST', path: new RegExp(`^identity/guest-invites/${ID}/revoke$`) },
  { method: 'POST', path: new RegExp(`^identity/guests/${ID}/revoke$`) },
  { method: 'PUT', path: new RegExp(`^identity/guests/${ID}/permissions$`) },
  { method: 'POST', path: new RegExp(`^identity/guests/${ID}/sessions/${ID}/revoke$`) },
  { method: 'POST', path: /^identity\/sessions\/others\/revoke$/ },
  { method: 'POST', path: new RegExp(`^identity/sessions/${ID}/revoke$`) },
  { method: 'PATCH', path: new RegExp(`^identity/passkeys/${ID}$`) },
  { method: 'DELETE', path: new RegExp(`^identity/passkeys/${ID}$`) },
  { method: 'POST', path: /^devices\/pairing\/(approve|approve-own|deny)$/ },
  { method: 'POST', path: new RegExp(`^devices/agents/${ID}/(maintenance|revoke)$`) },
];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `true` quando a chamada exige a chave e ela falta ou não é um UUID. */
export function missingIdempotencyKey(
  method: string,
  pathname: string,
  headers: Record<string, string>,
): boolean {
  const path = pathname.replace(/^\/api\/v1\//, '');
  if (path === pathname) return false;
  if (!ROUTES.some((r) => r.method === method && r.path.test(path))) return false;
  return !UUID.test(headers['idempotency-key'] ?? '');
}
