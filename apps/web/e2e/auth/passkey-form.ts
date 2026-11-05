import { Locator, Page } from '@playwright/test';

/**
 * O campo de senha do formulário de cadastro de passkey (Configurações > Segurança). Só o campo: a seção "Senha" da troca
 * de senha, na mesma tela, tem o mesmo nome acessível e o `getByLabel` sozinho a escolheria.
 */
export function passkeyPassword(page: Page): Locator {
  return page.getByLabel('Senha', { exact: true }).and(page.locator('input'));
}
