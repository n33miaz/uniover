import { Injectable } from '@angular/core';
import { APP_CONFIG } from '../config/app-config';
import { uuidV7 } from '../offline-queue/uuid-v7';

/** Cabeçalho que o site envia nas escritas reenviáveis (a mesma chave devolve a resposta guardada, sem repetir o efeito). */
export const IDEMPOTENCY_HEADER = 'Idempotency-Key';

/** Sufixo do `type` do problema com que a API responde a um reenvio cujo primeiro envio ainda está em andamento. */
const IN_PROGRESS_PROBLEM = 'idempotency-in-progress';

/** Máximo de ações com chave guardada ao mesmo tempo; passou disso, a mais antiga é esquecida. */
const MAX_OPEN_KEYS = 200;

const ID = '[^/]+';

/**
 * As escritas reenviáveis para as quais o site envia `Idempotency-Key`. Caminhos depois de `/api/v1/`.
 * Fica de fora o que não é reenviável: login, renovação, QR, início e consulta do pareamento, comandos da TV.
 * Ao exigir a chave numa rota nova da API, a rota entra aqui também (o espelho no servidor é `RequireIdempotency`).
 */
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
  { method: 'POST', path: /^training\/catalog\/imports\/wger$/ },
];

const API_PREFIX = `${APP_CONFIG.apiBase}/v1/`;

/** Se a chamada `método` + `url` é uma das escritas que exigem a chave. */
export function requiresIdempotencyKey(method: string, url: string): boolean {
  const upper = method.toUpperCase();
  let pathname: string;
  try {
    pathname = new URL(url, 'http://local').pathname;
  } catch {
    return false;
  }
  if (!pathname.startsWith(API_PREFIX)) return false;
  const path = pathname.slice(API_PREFIX.length);
  return ROUTES.some((route) => route.method === upper && route.path.test(path));
}

/**
 * Depois de uma falha, o reenvio da mesma ação reaproveita a chave? Só quando a API pode não ter guardado o resultado:
 * sem resposta (a requisição pode ter chegado), 5xx, 408, 425 e 429 (a API não guarda esses e libera a chave) e o "em
 * andamento". Qualquer outra resposta da API é definitiva e fica guardada sob a chave (a 2xx e a 4xx do próprio
 * pedido): repetir a chave só devolveria a mesma resposta, então a próxima tentativa usa chave nova.
 */
export function keepsKeyAfter(status: number, kind: string): boolean {
  return (
    status === 0 ||
    status >= 500 ||
    status === 408 ||
    status === 425 ||
    status === 429 ||
    (status === 409 && kind === IN_PROGRESS_PROBLEM)
  );
}

/** A chave de uma tentativa em curso e o aviso de como ela terminou. */
export interface IdempotencyTicket {
  /** `null` quando a rota não pede chave. */
  readonly key: string | null;
  /** Informa o resultado: sucesso (`status` 2xx) ou o problema (`status` e `kind` do erro, `0` se sem resposta). */
  readonly settle: (status: number, kind?: string) => void;
}

const NO_KEY: IdempotencyTicket = { key: null, settle: () => undefined };

/**
 * Chave por ação do usuário (e não por clique): a mesma escrita (método, endereço e corpo iguais) reaproveita a chave
 * enquanto não tiver terminado de forma definitiva, então o toque duplo e o reenvio depois de uma falha de rede não
 * repetem o efeito no servidor. Corpo diferente é outra ação e ganha chave nova. Fica só na memória da aba: recarregar a
 * página recomeça (a fila offline, que sobrevive a isso, guarda a própria chave por item).
 */
@Injectable({ providedIn: 'root' })
export class IdempotencyKeys {
  private readonly open = new Map<string, string>();

  begin(method: string, url: string, body: string): IdempotencyTicket {
    if (!requiresIdempotencyKey(method, url)) return NO_KEY;

    const fingerprint = `${method.toUpperCase()} ${url}\n${body}`;
    let key = this.open.get(fingerprint);
    if (key === undefined) {
      key = uuidV7();
      if (this.open.size >= MAX_OPEN_KEYS) {
        const oldest = this.open.keys().next().value;
        if (oldest !== undefined) this.open.delete(oldest);
      }
      this.open.set(fingerprint, key);
    }

    const issued = key;
    return {
      key: issued,
      settle: (status, kind = '') => {
        // Só solta a chave que esta tentativa usou (outra tentativa idêntica já pode ter trocado).
        if (!keepsKeyAfter(status, kind) && this.open.get(fingerprint) === issued) {
          this.open.delete(fingerprint);
        }
      },
    };
  }
}
