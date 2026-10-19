/**
 * Margem com que o aparelho recua o cursor antes de puxar. Cobre a janela em que uma gravação do servidor ficou
 * visível para a leitura depois de outra mais nova (transações que terminam fora de ordem): reaplicar é idempotente,
 * então reler dois minutos a mais custa pouco e nunca perde linha.
 */
export const CURSOR_REWIND_MS = 2 * 60 * 1000;

// O .NET conta o tempo em "ticks" de 100 ns; 1 ms = 10.000 ticks.
const TICKS_PER_MS = 10_000n;
const LOWEST_ID = '00000000-0000-0000-0000-000000000000';

/**
 * O cursor da API é um texto opaco, mas de formato estável e documentado: base64url (sem preenchimento) de
 * `<ticks UTC>|<uuid>`. Devolve o mesmo cursor recuado em `ms`, com o menor id possível (tudo o que tem o instante
 * recuado ou depois entra). Os ticks de hoje passam de 2^53, por isso a conta é em `BigInt`.
 *
 * Cursor ilegível devolve `null`: o chamador puxa desde o começo, que é lento mas se corrige sozinho.
 */
export function rewindCursor(cursor: string, ms: number): string | null {
  try {
    const base64 = cursor.replace(/-/g, '+').replace(/_/g, '/');
    const text = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '='));
    const parts = text.split('|');
    if (parts.length !== 2 || !/^\d+$/.test(parts[0])) return null;

    const rewound = BigInt(parts[0]) - BigInt(Math.round(ms)) * TICKS_PER_MS;
    const next = `${rewound > 0n ? rewound : 0n}|${LOWEST_ID}`;
    return btoa(next).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  } catch {
    return null;
  }
}
