import { Page } from '@playwright/test';
import { expect, expectNoHorizontalScroll, test } from '../fixtures';
import {
  dropConnection,
  expectNoA11yViolations,
  failWith,
  pressKeyWithCapsLock,
} from './entry-helpers';
import { IdentityMock, OWNER, mockIdentityApi } from './identity-mock';

// A API é simulada pelas rotas do Playwright, que não enxergam o que passa pelo service worker.
test.use({ serviceWorkers: 'block' });

let mock: IdentityMock;

test.beforeEach(async ({ context }) => {
  mock = await mockIdentityApi(context);
});

const email = (page: Page) => page.getByLabel('E-mail');
const password = (page: Page) => page.getByLabel('Senha', { exact: true });
const submit = (page: Page) => page.getByRole('button', { name: 'Entrar', exact: true });

async function openLogin(page: Page) {
  await page.goto('/entrar');
  await expect(page.getByRole('heading', { level: 1, name: 'Entrar' })).toBeVisible();
}

async function fill(page: Page, mail = OWNER.email, secret = OWNER.password) {
  await email(page).fill(mail);
  await password(page).fill(secret);
}

test.describe('tela de entrada: estrutura', () => {
  test('marca, um título só, um marco principal, rótulos visíveis e dicas de teclado e autopreenchimento', async ({
    page,
  }) => {
    await openLogin(page);
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
    await expect(page.getByRole('main')).toHaveCount(1);
    await expect(page.getByRole('main').getByText('UniOver', { exact: true })).toBeVisible();
    await expect(page.locator('label[for="login-email"]')).toBeVisible();
    await expect(page.locator('label[for="login-password"]')).toBeVisible();

    await expect(email(page)).toHaveAttribute('type', 'email');
    await expect(email(page)).toHaveAttribute('autocomplete', 'username');
    await expect(email(page)).toHaveAttribute('inputmode', 'email');
    await expect(email(page)).toHaveAttribute('autocapitalize', 'none');
    await expect(email(page)).toHaveAttribute('autocorrect', 'off');
    await expect(email(page)).toHaveAttribute('spellcheck', 'false');
    await expect(email(page)).toHaveAttribute('enterkeyhint', 'next');
    await expect(password(page)).toHaveAttribute('type', 'password');
    await expect(password(page)).toHaveAttribute('autocomplete', 'current-password');
    await expect(password(page)).toHaveAttribute('enterkeyhint', 'go');

    // Não existe recuperação de senha nem "lembrar de mim" neste sistema.
    await expect(page.getByText(/esqueci|recuperar|lembrar/i)).toHaveCount(0);
    await expectNoHorizontalScroll(page);
  });

  test('o campo de entrada de cada controle tem pelo menos 44 px de toque', async ({ page }) => {
    await openLogin(page);
    for (const control of [
      email(page),
      password(page),
      page.getByRole('button', { name: 'Mostrar senha' }),
      submit(page),
    ]) {
      const box = (await control.boundingBox())!;
      expect(box.height).toBeGreaterThanOrEqual(44);
      expect(box.width).toBeGreaterThanOrEqual(44);
    }
  });

  test('a entrada suave só anima quando a pessoa não pediu menos movimento', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await openLogin(page);
    const animation = () =>
      page.locator('.card').evaluate((card) => getComputedStyle(card).animationName);
    expect(await animation()).not.toBe('none');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    expect(await animation()).toBe('none');
  });

  test('cabe sem rolagem lateral nas duas orientações do celular', async ({ page }) => {
    await openLogin(page);
    await expectNoHorizontalScroll(page);
    await page.setViewportSize({ width: 844, height: 390 });
    await expectNoHorizontalScroll(page);
    // Em paisagem baixa a marca vai para o lado: o formulário inteiro aparece sem rolar.
    await expect(submit(page)).toBeInViewport({ ratio: 1 });
  });
});

test.describe('tela de entrada: campos', () => {
  test('Enter envia, e o e-mail digitado não fica guardado no aparelho', async ({ page }) => {
    await openLogin(page);
    await fill(page);
    await password(page).press('Enter');
    await expect(page).toHaveURL(/\/$/);
    const stored = await page.evaluate(
      () => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }),
    );
    expect(stored).not.toContain(OWNER.email);
    expect(stored).not.toContain(OWNER.password);
  });

  test('mostrar e ocultar a senha, com o botão sempre rotulado', async ({ page }) => {
    await openLogin(page);
    await password(page).fill('segredo-de-teste');
    const toggle = page.getByRole('button', { name: 'Mostrar senha' });
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await expect(password(page)).toHaveAttribute('type', 'text');
    await expect(password(page)).toHaveValue('segredo-de-teste');
    await toggle.click();
    await expect(password(page)).toHaveAttribute('type', 'password');
  });

  test('aviso de Caps Lock: aparece com a tecla ligada, some ao desligar e ao sair do campo', async ({
    page,
  }) => {
    await openLogin(page);
    await password(page).focus();
    await pressKeyWithCapsLock(password(page), true);
    const warning = page.getByText('Caps Lock ligado');
    await expect(warning).toBeVisible();
    // É dica cortês, não erro: nenhum alerta na tela.
    await expect(page.getByRole('alert')).toHaveCount(0);
    await pressKeyWithCapsLock(password(page), false);
    await expect(warning).toHaveCount(0);

    await pressKeyWithCapsLock(password(page), true);
    await expect(warning).toBeVisible();
    await password(page).blur();
    await expect(warning).toHaveCount(0);
  });

  test('apertar o botão com o aviso de Caps Lock na tela não perde o clique (a tela não se mexe sob o dedo)', async ({
    page,
  }) => {
    await openLogin(page);
    await fill(page, OWNER.email, 'errada');
    await password(page).focus();
    await pressKeyWithCapsLock(password(page), true);
    await expect(page.getByText('Caps Lock ligado')).toBeVisible();
    await submit(page).scrollIntoViewIfNeeded();
    const box = (await submit(page).boundingBox())!;
    // Perto da borda de baixo: se o aviso sumisse e o botão subisse, o ponteiro ficaria fora dele.
    await page.mouse.move(box.x + box.width / 2, box.y + box.height - 2);
    await page.mouse.down();
    // O tempo de um toque de verdade: se o campo perdesse o foco aqui, o aviso sumiria e o botão subiria.
    await page.waitForTimeout(300);
    await page.mouse.up();
    await expect(page.getByRole('alert')).toContainText('E-mail ou senha incorretos.');
  });

  test('validação gentil: só depois de sair do campo ou de enviar, e o foco vai ao primeiro inválido', async ({
    page,
  }) => {
    await openLogin(page);
    await email(page).fill('ana');
    await expect(page.locator('#login-email-error')).toHaveCount(0);
    await email(page).blur();
    await expect(page.locator('#login-email-error')).toContainText('Confira o e-mail');
    await expect(email(page)).toHaveAttribute('aria-invalid', 'true');
    await expect(email(page)).toHaveAttribute('aria-describedby', 'login-email-error');
    await email(page).fill('ana@exemplo.com');
    await expect(page.locator('#login-email-error')).toHaveCount(0);

    await page.reload();
    await submit(page).click();
    await expect(page.locator('#login-email-error')).toHaveText('Informe o seu e-mail.');
    await expect(page.locator('#login-password-error')).toHaveText('Informe a sua senha.');
    await expect(email(page)).toBeFocused();
    expect(mock.requests.filter((r) => r.path === '/auth/login')).toHaveLength(0);
    // O botão nunca fica desabilitado por campo vazio: ele leva ao aviso.
    await expect(submit(page)).toBeEnabled();

    await email(page).fill(OWNER.email);
    await submit(page).click();
    await expect(password(page)).toBeFocused();
  });

  test('a marca e o cartão ficam parados quando a faixa de erro aparece (só o que está embaixo desce)', async ({
    page,
  }) => {
    await openLogin(page);
    await fill(page, OWNER.email, 'errada');
    // Posição na página (soma a rolagem): se o foco no aviso rolar a tela, isso não é o cartão pulando.
    const top = (selector: string) =>
      page.evaluate((css) => {
        const element = document.querySelector(css)!;
        return Promise.all(element.getAnimations().map((a) => a.finished)).then(
          () => element.getBoundingClientRect().top + window.scrollY,
        );
      }, selector);
    const before = {
      mark: await top('app-auth-layout .mark'),
      card: await top('app-auth-layout .card'),
    };
    await submit(page).click();
    await expect(page.getByRole('alert')).toContainText('E-mail ou senha incorretos.');
    const after = {
      mark: await top('app-auth-layout .mark'),
      card: await top('app-auth-layout .card'),
    };
    expect(Math.abs(after.mark - before.mark)).toBeLessThanOrEqual(1);
    expect(Math.abs(after.card - before.card)).toBeLessThanOrEqual(1);
  });

  test('o botão mostra que está enviando sem mudar de largura e sem se desabilitar antes', async ({
    page,
  }) => {
    await openLogin(page);
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    await page.route('**/api/v1/identity/auth/login', async (route) => {
      await held;
      await route.fallback();
    });
    await fill(page);
    const before = (await submit(page).boundingBox())!;
    await submit(page).click();
    const sending = page.getByRole('button', { name: 'Entrando…' });
    await expect(sending).toBeDisabled();
    const during = (await sending.boundingBox())!;
    expect(Math.abs(during.width - before.width)).toBeLessThanOrEqual(1);
    expect(Math.abs(during.height - before.height)).toBeLessThanOrEqual(1);
    release();
    await expect(page).toHaveURL(/\/$/);
  });

  test('quem já tem sessão válida segue direto, sem ver o formulário', async ({ page }) => {
    await openLogin(page);
    await fill(page);
    await submit(page).click();
    await expect(page).toHaveURL(/\/$/);
    await page.goto('/entrar?next=%2Fajustes');
    await expect(page).toHaveURL(/\/ajustes$/);
  });
});

test.describe('tela de entrada: erros por tipo', () => {
  test('senha errada: a mesma mensagem de sempre, em alerta, com foco, e nada diz qual dado errou', async ({
    page,
  }) => {
    await openLogin(page);
    await fill(page, OWNER.email, 'errada');
    await submit(page).click();
    const alert = page.getByRole('alert');
    await expect(alert).toContainText('E-mail ou senha incorretos.');
    await expect(alert).toBeFocused();
    await expect(email(page)).not.toHaveAttribute('aria-invalid', 'true');
    await expect(password(page)).not.toHaveAttribute('aria-invalid', 'true');
    // E-mail que não existe: exatamente a mesma resposta.
    const same = await alert.textContent();
    await fill(page, 'ninguem@exemplo.com', 'qualquer-coisa-longa');
    await submit(page).click();
    await expect(alert).toHaveText(same!);
  });

  test('conta bloqueada: explica, conta a espera em m:ss e tranca o botão', async ({ page }) => {
    await failWith(page, '/auth/login', 429, 'login-locked', { 'retry-after': '125' });
    await openLogin(page);
    await fill(page);
    await submit(page).click();
    const alert = page.getByRole('alert');
    await expect(alert).toContainText('Conta bloqueada');
    await expect(page.locator('.wait-time')).toHaveText(/^\d:\d{2}$/);
    // O leitor de tela ouve a espera uma vez, em palavras, e não o número andando.
    await expect(page.locator('.wait')).toHaveAttribute('aria-hidden', 'true');
    await expect(alert).toContainText('Tente de novo em 3 minutos.');
    await expect(submit(page)).toBeDisabled();
  });

  test('limite de tentativas: mensagem própria, com contagem', async ({ page }) => {
    await failWith(page, '/auth/login', 429, 'rate-limited', { 'retry-after': '30' });
    await openLogin(page);
    await fill(page);
    await submit(page).click();
    await expect(page.getByRole('alert')).toContainText('Muitas tentativas seguidas');
    await expect(page.locator('.wait-time')).toHaveText(/^\d:\d{2}$/);
    await expect(submit(page)).toBeDisabled();
  });

  test('sem rede: avisa e deixa tentar de novo', async ({ page }) => {
    await openLogin(page);
    await dropConnection(page, '/auth/login');
    await fill(page);
    await submit(page).click();
    await expect(page.getByRole('alert')).toContainText('Sem conexão com o servidor');
    await expect(submit(page)).toBeEnabled();
  });

  test('erro do servidor: mensagem humana, sem culpar a senha', async ({ page }) => {
    await failWith(page, '/auth/login', 500, 'internal');
    await openLogin(page);
    await fill(page);
    await submit(page).click();
    await expect(page.getByRole('alert')).toContainText('Não foi possível entrar agora');
    await expect(submit(page)).toBeEnabled();
  });
});

test.describe('tela de entrada: teclado virtual', () => {
  test('com a janela baixa (teclado aberto) o campo em foco e o botão continuam alcançáveis', async ({
    page,
  }) => {
    await openLogin(page);
    await password(page).focus();
    const width = page.viewportSize()!.width;
    // O teclado do celular cobre cerca de metade da altura: simulado pela janela baixa.
    await page.setViewportSize({ width, height: 300 });
    await expect(password(page)).toBeInViewport({ ratio: 1 });
    await submit(page).scrollIntoViewIfNeeded();
    await expect(submit(page)).toBeInViewport({ ratio: 1 });
    await expectNoHorizontalScroll(page);

    // E o campo de cima também, ao trocar o foco.
    await email(page).focus();
    await expect(email(page)).toBeInViewport({ ratio: 1 });
  });
});

test.describe('tela de entrada: acessibilidade (axe, qualquer gravidade)', () => {
  for (const scheme of ['light', 'dark'] as const) {
    test(`campos, avisos de campo e Caps Lock no tema ${scheme}`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await openLogin(page);
      await expectNoA11yViolations(page);
      await submit(page).click();
      await expect(page.locator('#login-email-error')).toBeVisible();
      await expectNoA11yViolations(page);
      await password(page).focus();
      await pressKeyWithCapsLock(password(page), true);
      await expect(page.getByText('Caps Lock ligado')).toBeVisible();
      await expectNoA11yViolations(page);
    });

    test(`sem rede, com o aviso global da conexão, no tema ${scheme}`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await openLogin(page);
      await dropConnection(page, '/auth/login');
      await fill(page);
      await submit(page).click();
      await expect(page.getByRole('alert')).toContainText('Sem conexão com o servidor');
      // O aviso global fica acima da tela de entrada: ele não pode criar violação (marcos, regiões).
      await expect(page.locator('app-connectivity-banner .banner')).toBeVisible();
      await expectNoA11yViolations(page);
    });

    test(`faixas de erro e de espera no tema ${scheme}`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await openLogin(page);
      await fill(page, OWNER.email, 'errada');
      await submit(page).click();
      await expect(page.getByRole('alert')).toContainText('incorretos');
      await expectNoA11yViolations(page);

      await failWith(page, '/auth/login', 429, 'login-locked', { 'retry-after': '40' });
      await submit(page).click();
      await expect(page.getByRole('alert')).toContainText('Conta bloqueada');
      await expectNoA11yViolations(page);
    });
  }
});
