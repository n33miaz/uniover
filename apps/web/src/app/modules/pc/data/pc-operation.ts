/** O cabeçalho que leva o código da operação à API (que o repassa ao agente e o registra junto com ele). */
export const OPERATION_HEADER = 'X-Operation-Id';

/**
 * Um código novo por comando: 16 caracteres hexadecimais aleatórios, no formato que o contrato aceita (8 a 40 letras, números,
 * `_` e `-`). É só um nome para seguir o toque nos registros; nunca leva texto, tecla nem coordenada.
 */
export function newOperationId(): string {
  const bytes = new Uint8Array(8);
  const crypto = globalThis.crypto as Crypto | undefined;
  if (crypto?.getRandomValues) {
    crypto.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index++)
      bytes[index] = Math.floor(Math.random() * 256);
  }
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
