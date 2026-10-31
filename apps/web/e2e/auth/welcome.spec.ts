import { Page } from '@playwright/test';
import { expect, expectNoHorizontalScroll, screenshot, test } from '../fixtures';
import { settle, smallTargets } from '../screens/screen-helpers';
import { dropConnection, expectNoA11yViolations, failWith } from './entry-helpers';
import { GUEST, IdentityMock, OWNER, mockIdentityApi } from './identity-mock';

// A API é simulada pelas rotas do Playwright, que não enxergam o que passa pelo service worker.
test.use({ serviceWorkers: 'block' });

let mock: IdentityMock;

test.beforeEach(async ({ context }) => {
  mock = await mockIdentityApi(context);
});

const nameField = (page: Page) => page.getByLabel('Seu nome');
const submit = (page: Page) => page.getByRole('button', { name: 'Continuar' });
const greeting = (page: Page) => page.getByRole('heading', { level: 1 });

async function signIn(page: Page) {
  await page.goto('/entrar');
  await page.getByLabel('E-mail').fill(OWNER.email);
  await page.getByLabel('Senha', { exact: true }).fill(OWNER.password);
  await page.getByRole('button', { name: 'Entrar', exact: true }).click();
}

async function acceptInvite(page: Page) {
  const invite = mock.seedInvite();
  await page.goto(`/convite#${invite.token}`);
  await page.getByLabel('E-mail').fill(GUEST.email);
  await page.getByLabel('Senha', { exact: true }).fill(GUEST.password);
  await page.getByLabel('Repita a senha').fill(GUEST.password);
  await page.getByRole('button', { name: 'Continuar', exact: true }).click();
}

function shot(info: { project: { name: string } }, name: string, scheme: string) {
  return `test-results/welcome/${name}-${info.project.name}-${scheme}.png`;
}

test.describe('primeiro acesso: como devemos te chamar', () => {
  test('o administrador entra, responde e cai na Início com o nome escolhido', async ({ page }) => {
    mock.owner.confirmed = false;
    await signIn(page);

    // Antes de qualquer tela, a pergunta, com o nome que a conta já tem preenchido.
    await expect(page).toHaveURL(/\/boas-vindas$/);
    await expect(greeting(page)).toHaveText('Como devemos te chamar?');
    await expect(nameField(page)).toHaveValue(OWNER.displayName);
    await expect(page.getByText('Dá para mudar depois, em Configurações.')).toBeVisible();

    await nameField(page).fill('  Neemias   ');
    await submit(page).click();
    await expect(page).toHaveURL(/\/$/);
    await expect(greeting(page)).toHaveText(/(Bom dia|Boa tarde|Boa noite), Neemias/);
    expect(mock.owner).toEqual({ displayName: 'Neemias', confirmed: true });

    // Quem já escolheu nunca mais a vê: nem entrando de novo, nem indo ao endereço.
    await page.reload();
    await expect(page).toHaveURL(/\/$/);
    await page.goto('/boas-vindas');
    await expect(page).toHaveURL(/\/$/);
    await expect(greeting(page)).toContainText('Neemias');
  });

  test('guarda o destino: quem queria ir a Configurações volta para lá depois de responder', async ({
    page,
  }) => {
    mock.owner.confirmed = false;
    mock.loggedIn = true;
    await page.goto('/ajustes/perfil');
    await expect(page).toHaveURL(/\/boas-vindas\?next=%2Fajustes%2Fperfil$/);
    await nameField(page).fill('Neemias');
    await submit(page).click();
    await expect(page).toHaveURL(/\/ajustes\/perfil$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Perfil' })).toBeVisible();
    await expect(page.locator('.person')).toHaveText('Neemias');
  });

  test('a convidada responde antes da Início e depois cai nela', async ({ page }) => {
    mock.guestsStartUnconfirmed = true;
    await acceptInvite(page);
    await expect(page).toHaveURL(/\/boas-vindas$/);
    // O nome que veio no convite já vem preenchido.
    await expect(nameField(page)).toHaveValue(GUEST.displayName);
    await nameField(page).fill('Alice Souza');
    await submit(page).click();
    await expect(page).toHaveURL(/\/$/);
    expect(mock.guests.at(-1)?.displayName).toBe('Alice Souza');
    expect(mock.guests.at(-1)?.nameConfirmed).toBe(true);
  });

  test('a convidada que já escolheu o nome vai direto à Início', async ({ page }) => {
    await acceptInvite(page);
    await expect(page).toHaveURL(/\/$/);
    await page.goto('/boas-vindas');
    await expect(page).toHaveURL(/\/$/);
  });

  test('sem sessão, o endereço da pergunta leva à entrada', async ({ page }) => {
    await page.goto('/boas-vindas');
    await expect(page).toHaveURL(/\/entrar$/);
  });

  test('nome vazio é explicado no campo, sem ir ao servidor e sem desabilitar o botão', async ({
    page,
  }) => {
    mock.owner.confirmed = false;
    await signIn(page);
    await nameField(page).fill('   ');
    await submit(page).click();
    await expect(page.getByText('Escreva como devemos te chamar.')).toBeVisible();
    await expect(nameField(page)).toHaveAttribute('aria-invalid', 'true');
    await expect(nameField(page)).toBeFocused();
    await expect(submit(page)).toBeEnabled();
    expect(mock.requests.filter((r) => r.method === 'PATCH')).toEqual([]);
  });

  test('o contador conta como a API (emoji vale um) e avisa ao passar de 60', async ({ page }) => {
    mock.owner.confirmed = false;
    await signIn(page);
    await nameField(page).fill('Ana \u{1F600}');
    await expect(page.locator('#welcome-name-counter')).toHaveText('5 de 60');
    await nameField(page).fill('a'.repeat(61));
    await expect(page.locator('#welcome-name-counter')).toHaveText('61 de 60');
    await expect(page.getByText('O nome pode ter até 60 caracteres.')).toBeVisible();
    await submit(page).click();
    expect(mock.requests.filter((r) => r.method === 'PATCH')).toEqual([]);
    await nameField(page).fill('a'.repeat(60));
    await expect(page.getByText('O nome pode ter até 60 caracteres.')).toHaveCount(0);
  });

  test('a mensagem do servidor para o nome aparece no campo, e o nome continua lá', async ({
    page,
  }) => {
    mock.owner.confirmed = false;
    await signIn(page);
    await nameField(page).fill('Nei​mias');
    await submit(page).click();
    await expect(page.getByText('Use só letras, números, espaços e emojis comuns')).toBeVisible();
    await expect(nameField(page)).toHaveAttribute('aria-invalid', 'true');
    await expect(page).toHaveURL(/\/boas-vindas$/);
    // Corrigindo o texto, a mensagem some e o envio vale.
    await nameField(page).fill('Neemias');
    await expect(page.getByText('Use só letras, números, espaços e emojis comuns')).toHaveCount(0);
    await submit(page).click();
    await expect(page).toHaveURL(/\/$/);
  });

  test('falha de rede não prende ninguém: avisa, deixa tentar de novo e depois segue', async ({
    page,
  }) => {
    mock.owner.confirmed = false;
    await signIn(page);
    await expect(page).toHaveURL(/\/boas-vindas$/);
    await nameField(page).fill('Neemias');
    await dropConnection(page, '/me');
    await submit(page).click();
    const alert = page.getByRole('alert');
    await expect(alert).toContainText('Sem conexão com o servidor.');
    await expect(alert).toContainText('O nome não foi salvo.');
    await expect(alert).toBeFocused();
    await expect(page).toHaveURL(/\/boas-vindas$/);
    await expect(nameField(page)).toHaveValue('Neemias');
    await expect(submit(page)).toBeEnabled();

    // A rede volta: o mesmo botão salva. Nada de laço de redirecionamento: uma ida, uma volta.
    await page.unroute('**/api/v1/identity/me');
    await submit(page).click();
    await expect(page).toHaveURL(/\/$/);
    expect(mock.owner.confirmed).toBe(true);
  });

  test('limite de tentativas e conta sem acesso são avisados sem sair da tela', async ({
    page,
  }) => {
    mock.owner.confirmed = false;
    await signIn(page);
    mock.patchRetryAfter = 30;
    await submit(page).click();
    await expect(page.getByRole('alert')).toContainText('Muitas tentativas seguidas.');
    await expect(page.getByRole('alert')).toContainText('30 segundos');
    mock.patchRetryAfter = null;
    mock.patchForbidden = true;
    await submit(page).click();
    await expect(page.getByRole('alert')).toContainText('não tem mais acesso');
    await expect(page).toHaveURL(/\/boas-vindas$/);
  });

  test('uma falha do servidor ao ler a conta não prende: a casca abre', async ({ page }) => {
    mock.owner.confirmed = false;
    mock.loggedIn = true;
    await failWith(page, '/me', 500, 'server-error');
    await page.goto('/');
    await expect(greeting(page)).toBeVisible();
    await expect(page).toHaveURL(/\/$/);
  });
});

test.describe('primeiro acesso: telas', () => {
  for (const scheme of ['light', 'dark'] as const) {
    test(`print, acessibilidade, alvos e rolagem no tema ${scheme}`, async ({ page }, info) => {
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
      mock.owner.confirmed = false;
      mock.loggedIn = true;
      await page.goto('/boas-vindas');
      await expect(greeting(page)).toHaveText('Como devemos te chamar?');
      await settle(page);
      await expectNoHorizontalScroll(page);
      await screenshot(page, shot(info, 'welcome', scheme));
      await expectNoA11yViolations(page);
      expect(await smallTargets(page)).toEqual([]);
      for (const control of [nameField(page), submit(page)]) {
        const size = (await control.boundingBox())!;
        expect(size.height).toBeGreaterThanOrEqual(44);
      }

      // Com um aviso de campo e com o aviso de rede.
      await nameField(page).fill('');
      await submit(page).click();
      await expect(page.getByText('Escreva como devemos te chamar.')).toBeVisible();
      await settle(page);
      await screenshot(page, shot(info, 'welcome-empty', scheme));
      await expectNoA11yViolations(page);

      await nameField(page).fill('Neemias');
      await dropConnection(page, '/me');
      await submit(page).click();
      await expect(page.getByRole('alert')).toContainText('Sem conexão com o servidor.');
      await settle(page);
      await screenshot(page, shot(info, 'welcome-offline', scheme));
      await expectNoA11yViolations(page);
    });

    test(`em paisagem curta (844x390) o formulário cabe, no tema ${scheme}`, async ({
      page,
    }, info) => {
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
      await page.setViewportSize({ width: 844, height: 390 });
      mock.owner.confirmed = false;
      mock.loggedIn = true;
      await page.goto('/boas-vindas');
      await expect(greeting(page)).toHaveText('Como devemos te chamar?');
      await settle(page);
      await expectNoHorizontalScroll(page);
      await expect(submit(page)).toBeVisible();
      await screenshot(page, shot(info, 'welcome-landscape', scheme));
    });
  }

  test('o foco por teclado é visível e o Enter envia', async ({ page }) => {
    mock.owner.confirmed = false;
    mock.loggedIn = true;
    await page.goto('/boas-vindas');
    await nameField(page).focus();
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Tab');
    await expect(nameField(page)).toBeFocused();
    const outline = await nameField(page).evaluate((el) => {
      const style = getComputedStyle(el);
      return { style: style.outlineStyle, width: parseFloat(style.outlineWidth) };
    });
    expect(outline.style).not.toBe('none');
    expect(outline.width).toBeGreaterThanOrEqual(2);
    await nameField(page).fill('Neemias');
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/$/);
  });
});

test.describe('o Perfil muda o nome a qualquer hora', () => {
  test('salva sem navegar e a saudação da Início muda', async ({ page }) => {
    mock.loggedIn = true;
    await page.goto('/ajustes/perfil');
    await expect(page.getByRole('heading', { level: 1, name: 'Perfil' })).toBeVisible();
    const field = page.getByLabel('Como devemos te chamar');
    await expect(field).toHaveValue(OWNER.displayName);
    const save = page.getByRole('button', { name: 'Salvar' });
    await expect(save).toBeDisabled();

    await field.fill('Neemias Jr');
    await expect(save).toBeEnabled();
    await save.click();
    await expect(page.getByText('Nome salvo.')).toBeVisible();
    await expect(page).toHaveURL(/\/ajustes\/perfil$/);
    await expect(page.locator('.person')).toHaveText('Neemias Jr');
    await expect(save).toBeDisabled();
    expect(mock.owner.displayName).toBe('Neemias Jr');

    // Volta pela seta (Perfil -> lista -> Início): a saudação já traz o nome novo, sem recarregar a página.
    await page.getByRole('button', { name: 'Voltar às Configurações' }).click();
    await page.getByRole('button', { name: 'Voltar ao Início' }).click();
    await expect(page).toHaveURL(/\/$/);
    // A saudação traz só o primeiro nome: "Neemias Jr" vira "Neemias".
    await expect(page.locator('app-home-page h1')).toHaveText(/, Neemias$/);
  });

  test('mostra no campo o erro do servidor e uma falha de rede, sem perder o que foi digitado', async ({
    page,
  }) => {
    mock.loggedIn = true;
    await page.goto('/ajustes/perfil');
    const field = page.getByLabel('Como devemos te chamar');
    const save = page.getByRole('button', { name: 'Salvar' });

    await field.fill('Nei​mias');
    await save.click();
    await expect(page.getByText('Use só letras, números, espaços e emojis comuns')).toBeVisible();
    await expect(field).toHaveAttribute('aria-invalid', 'true');
    await expect(field).toBeFocused();

    await field.fill('Neemias');
    await dropConnection(page, '/me');
    await save.click();
    await expect(page.getByRole('alert')).toContainText('Sem conexão com o servidor.');
    await expect(field).toHaveValue('Neemias');
    await page.unroute('**/api/v1/identity/me');
    await save.click();
    await expect(page.getByText('Nome salvo.')).toBeVisible();
  });
});
