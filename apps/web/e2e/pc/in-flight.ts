import { Page } from '@playwright/test';
import { expect } from '../fixtures';
import { PcMock } from './pc-mock';

/** `DEFAULT_BATCHER.minIntervalMs`: o lote de movimento sai no máximo uma vez por este intervalo. */
const BATCH_INTERVAL_MS = 32;

export interface PostTracker {
  /** O simulador registrou todo POST para `path` que a página já fez: o que estava a caminho chegou. */
  landed(path: string): Promise<void>;
  /**
   * Como `landed`, e também a sobra do lote de movimento: ela sai num último pedido até um intervalo de lote depois do
   * anterior. Um timer da página com prazo maior, marcado depois, só dispara depois do dela; se nada novo saiu, acabou.
   */
  drained(path: string): Promise<void>;
}

/**
 * Conta os POST que a página faz para a API do PC (o evento `request` sai quando o pedido começa) e devolve esperas por
 * condição no lugar do "espera um pouco". Chamar antes de abrir a tela, para contar desde o primeiro pedido.
 */
export function trackPosts(page: Page, pc: PcMock): PostTracker {
  const issued: string[] = [];
  page.on('request', (request) => {
    if (request.method() !== 'POST') return;
    const { pathname } = new URL(request.url());
    if (pathname.startsWith('/api/v1/pc/')) issued.push(pathname.replace('/api/v1/pc', ''));
  });
  const count = (path: string) => issued.filter((sent) => sent === path).length;
  const landed = async (path: string) => {
    await expect.poll(() => count(path) - pc.sent(path).length).toBe(0);
  };
  return {
    landed,
    async drained(path) {
      for (;;) {
        await landed(path);
        const before = count(path);
        await page.evaluate(
          (ms) => new Promise<void>((done) => setTimeout(done, ms)),
          BATCH_INTERVAL_MS + 8,
        );
        await landed(path);
        if (count(path) === before) return;
      }
    },
  };
}
