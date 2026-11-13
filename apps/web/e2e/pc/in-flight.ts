import { Page } from '@playwright/test';
import { expect } from '../fixtures';
import { PcMock } from './pc-mock';

/**
 * Conta os POST que a página já fez para a API do PC (o evento `request` sai quando o pedido começa) e devolve uma espera
 * por condição: o simulador registrou todos os de `path`, ou seja, o que estava a caminho chegou. Chamar antes de abrir a
 * tela, para contar desde o primeiro pedido.
 */
export function trackPosts(page: Page, pc: PcMock): (path: string) => Promise<void> {
  const issued: string[] = [];
  page.on('request', (request) => {
    if (request.method() !== 'POST') return;
    const { pathname } = new URL(request.url());
    if (pathname.startsWith('/api/v1/pc/')) issued.push(pathname.replace('/api/v1/pc', ''));
  });
  return async (path) => {
    await expect
      .poll(() => issued.filter((sent) => sent === path).length - pc.sent(path).length)
      .toBe(0);
  };
}
