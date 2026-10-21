import AxeBuilder from '@axe-core/playwright';
import { Locator, Page } from '@playwright/test';
import { expect } from '../fixtures';

const PROBLEM_BASE = 'https://uniover.app/problems/';

/**
 * Nenhuma violação de acessibilidade, de qualquer gravidade. Conta também as boas práticas (regiões, ordem dos
 * títulos), então todo o conteúdo precisa estar dentro de um marco e a tela precisa ter um único `h1`.
 */
export async function expectNoA11yViolations(page: Page): Promise<void> {
  const { violations } = await new AxeBuilder({ page }).analyze();
  expect(
    violations.map(
      (v) => `${v.id} (${v.impact}): ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`,
    ),
  ).toEqual([]);
}

/** Responde a esta rota de identidade com um erro no formato da API. A rota da página vence a do contexto (o simulador). */
export async function failWith(
  page: Page,
  path: string,
  status: number,
  kind: string,
  headers: Record<string, string> = {},
): Promise<void> {
  await page.route(`**/api/v1/identity${path}`, (route) =>
    route.fulfill({
      status,
      headers: { 'content-type': 'application/problem+json', ...headers },
      body: JSON.stringify({ type: PROBLEM_BASE + kind, title: 'erro de teste', status }),
    }),
  );
}

/** Derruba esta rota como se a rede tivesse caído no meio do envio (a página já abriu: sem rede só a partir daqui). */
export async function dropConnection(page: Page, path: string): Promise<void> {
  await page.route(`**/api/v1/identity${path}`, (route) => route.abort('internetdisconnected'));
}

/**
 * Digita uma tecla com o Caps Lock "ligado" ou "desligado". O navegador de teste não liga a tecla de verdade, então
 * o evento carrega o estado pelo `getModifierState`, que é por onde o app o lê (funciona igual no WebKit e no Chromium).
 */
export async function pressKeyWithCapsLock(field: Locator, on: boolean): Promise<void> {
  await field.evaluate((element, state) => {
    const event = new KeyboardEvent('keydown', { key: 'a', bubbles: true });
    event.getModifierState = (modifier: string) => modifier === 'CapsLock' && state;
    element.dispatchEvent(event);
  }, on);
}

/**
 * Segura os scripts que a página pedir depois de `hold()` até `release()`. Serve para parar o app antes da navegação
 * seguinte: o pacote da próxima tela (carregado sob demanda) não chega, então a tela atual fica como está, sem
 * depender de relógio nem de pressa do teste.
 */
export async function gateScripts(page: Page): Promise<{ hold(): void; release(): void }> {
  let active = false;
  let open!: () => void;
  const released = new Promise<void>((resolve) => (open = resolve));
  await page.route('**/*.js', async (route) => {
    if (active) await released;
    await route.continue();
  });
  return {
    hold: () => {
      active = true;
    },
    release: () => {
      active = false;
      open();
    },
  };
}
