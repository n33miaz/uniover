import { Page } from '@playwright/test';
import { expect, expectNoHorizontalScroll, test } from '../fixtures';
import { dropConnection, expectNoA11yViolations, failWith, gateScripts } from './entry-helpers';
import { GUEST, IdentityMock, OWNER, mockIdentityApi } from './identity-mock';

// A API é simulada pelas rotas do Playwright, que não enxergam o que passa pelo service worker.
test.use({ serviceWorkers: 'block' });

let mock: IdentityMock;

test.beforeEach(async ({ context }) => {
  mock = await mockIdentityApi(context);
});

const STRONG = 'Uma-senha-bem-longa-9!';
/** Um segredo no formato certo que o simulador não conhece: a API responde 410. */
const UNKNOWN_LINK = '/convite#' + 'a'.repeat(43);

const email = (page: Page) => page.getByLabel('E-mail');
const password = (page: Page) => page.getByLabel('Senha', { exact: true });
const confirmation = (page: Page) => page.getByLabel('Repita a senha');
const submit = (page: Page) => page.getByRole('button', { name: 'Continuar', exact: true });

async function openInvite(page: Page, link = `/convite#${mock.seedInvite().token}`) {
  await page.goto(link);
}

async function openForm(page: Page, link?: string) {
  await openInvite(page, link);
  await expect(
    page.getByRole('heading', { level: 1, name: 'Criar conta', exact: true }),
  ).toBeVisible();
}

async function fill(page: Page, mail = GUEST.email, secret = STRONG, repeat = secret) {
  await email(page).fill(mail);
  await password(page).fill(secret);
  await confirmation(page).fill(repeat);
}

test.describe('convite: boas-vindas', () => {
  test('abre direto no formulário, avisa o que é registrado e tira o segredo do endereço', async ({
    page,
  }) => {
    const invite = mock.seedInvite();
    await openForm(page, `/convite#${invite.token}`);
    await expect(page).toHaveURL(/\/convite$/);
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
    await expect(page.getByRole('main')).toHaveCount(1);
    await expect(page.getByText('Este acesso fica registrado: data, IP e aparelho.')).toBeVisible();
    await expect(page.getByText('Não existe recuperação de senha')).toBeVisible();
    expect(await page.evaluate(() => document.body.innerText)).not.toContain(invite.token);
    await expectNoHorizontalScroll(page);
  });

  test('o botão de continuar aparece na primeira tela, sem rolar (também na janela baixa do iPhone)', async ({
    page,
  }) => {
    await openForm(page);
    await expect(submit(page)).toBeInViewport({ ratio: 1 });
    await expectNoHorizontalScroll(page);
  });

  test('campos com rótulo, dicas de autopreenchimento que ligam ao login e nenhum foco roubado', async ({
    page,
  }) => {
    await openForm(page);
    await expect(email(page)).toHaveAttribute('autocomplete', 'username');
    await expect(email(page)).toHaveAttribute('inputmode', 'email');
    await expect(email(page)).toHaveAttribute('autocapitalize', 'none');
    await expect(email(page)).toHaveAttribute('autocorrect', 'off');
    await expect(password(page)).toHaveAttribute('autocomplete', 'new-password');
    await expect(confirmation(page)).toHaveAttribute('autocomplete', 'new-password');
    await expect(confirmation(page)).toHaveAttribute('enterkeyhint', 'go');
    await expect(email(page)).not.toBeFocused();
    for (const control of [
      email(page),
      password(page),
      confirmation(page),
      page.getByRole('button', { name: 'Mostrar senha', exact: true }),
      page.getByRole('button', { name: 'Mostrar a senha repetida' }),
      submit(page),
    ]) {
      const box = (await control.boundingBox())!;
      expect(box.height).toBeGreaterThanOrEqual(44);
      expect(box.width).toBeGreaterThanOrEqual(44);
    }
  });

  test('mostrar e ocultar valem para cada senha separadamente', async ({ page }) => {
    await openForm(page);
    await password(page).fill(STRONG);
    await confirmation(page).fill(STRONG);
    await page.getByRole('button', { name: 'Mostrar senha', exact: true }).click();
    await expect(password(page)).toHaveAttribute('type', 'text');
    await expect(confirmation(page)).toHaveAttribute('type', 'password');
    await page.getByRole('button', { name: 'Mostrar a senha repetida' }).click();
    await expect(confirmation(page)).toHaveAttribute('type', 'text');
  });
});

test.describe('convite: requisitos ao vivo', () => {
  test('o requisito passa de pendente a cumprido enquanto se digita, em texto e não só em cor', async ({
    page,
  }) => {
    await openForm(page);
    const rules = page.getByRole('list', { name: 'Requisitos da senha' });
    const rule = rules.getByRole('listitem');
    await expect(rule).toContainText('Ao menos 10 caracteres');
    await expect(rule).toHaveAttribute('data-state', 'pending');
    await expect(rule).toContainText('pendente');

    await password(page).fill('curta1');
    await expect(rule).toHaveAttribute('data-state', 'pending');
    await password(page).fill('dez-letras');
    await expect(rule).toHaveAttribute('data-state', 'met');
    await expect(rule).toContainText('cumprido');
    await expect(password(page)).toHaveAttribute(
      'aria-describedby',
      'invite-password-rules invite-password-hint',
    );
  });

  test('a força é só conselho, nomeada por extenso, e não impede o envio de uma senha longa o bastante', async ({
    page,
  }) => {
    await openForm(page);
    await expect(page.getByText('Força da senha', { exact: true })).toBeVisible();
    for (const [typed, label] of [
      ['curta1', 'Força: Fraca'],
      ['abcdefghij', 'Força: Razoável'],
      ['abcdefghijklmn', 'Força: Boa'],
      [STRONG, 'Força: Forte'],
    ]) {
      await password(page).fill(typed);
      await expect(page.getByText(label, { exact: true })).toBeVisible();
    }
    await expect(page.locator('.segments')).toHaveAttribute('aria-hidden', 'true');
  });

  test('o leitor de tela ouve só o que mudou, numa região cortês, depois que a digitação para', async ({
    page,
  }) => {
    await openForm(page);
    const live = page.locator('p.ui-visually-hidden[role="status"]');
    await expect(live).toHaveText('');
    await password(page).pressSequentially('abcdefghijkl');
    await expect(live).toContainText('Requisito cumprido: ao menos 10 caracteres.', {
      timeout: 5_000,
    });
    await expect(live).toContainText('Força da senha: Razoável.');
    await confirmation(page).fill('abcdefghijkl');
    await expect(live).toHaveText('As senhas conferem.', { timeout: 5_000 });
  });

  test('confirmação: "conferem" na hora; divergência só depois de sair do campo', async ({
    page,
  }) => {
    await openForm(page);
    await password(page).fill(STRONG);
    await confirmation(page).fill(STRONG.slice(0, 8));
    await expect(page.locator('#invite-confirmation-status')).toHaveCount(0);
    await confirmation(page).blur();
    await expect(page.locator('#invite-confirmation-status')).toHaveText(
      'As senhas ainda não são iguais.',
    );
    await expect(confirmation(page)).toHaveAttribute('aria-invalid', 'true');
    // Indicador, não alerta: o único alerta aparece num envio recusado.
    await expect(page.getByRole('alert')).toHaveCount(0);
    await confirmation(page).fill(STRONG);
    await expect(page.locator('#invite-confirmation-status')).toHaveText('As senhas conferem.');
    await expect(confirmation(page)).not.toHaveAttribute('aria-invalid', 'true');
  });
});

test.describe('convite: aceite', () => {
  test('feliz: mostra "tudo pronto", segue sozinho para o controle e o segredo só viaja no corpo', async ({
    page,
  }) => {
    // A tela seguinte (carregada sob demanda) fica retida: o "tudo pronto" permanece até o teste soltá-la.
    const gate = await gateScripts(page);
    const invite = mock.seedInvite();
    await openForm(page, `/convite#${invite.token}`);
    gate.hold();
    await fill(page);
    await submit(page).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Tudo pronto' })).toBeVisible();
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
    await expect(page).toHaveURL(/\/convite$/);

    // Sem clicar em nada, ele segue sozinho.
    gate.release();
    await expect(page).toHaveURL(/\/tv$/);
    expect(mock.requests.every((r) => !r.url.includes(invite.token))).toBe(true);
    expect(mock.requests.filter((r) => r.path === '/guest-invites/accept')).toHaveLength(1);
  });

  test('"Continuar" leva ao controle sem esperar o tempo do "tudo pronto"', async ({ page }) => {
    const gate = await gateScripts(page);
    await openForm(page);
    gate.hold();
    await fill(page);
    await submit(page).click();
    // O botão do formulário também se chama "Continuar": só depois do "tudo pronto" ele sai de cena e sobra o do passo novo.
    await expect(page.getByRole('heading', { level: 1, name: 'Tudo pronto' })).toBeVisible();
    await page.getByRole('button', { name: 'Continuar', exact: true }).click();
    gate.release();
    await expect(page).toHaveURL(/\/tv$/);
  });

  test('senha curta e senhas diferentes são barradas no aparelho, com o foco no campo certo', async ({
    page,
  }) => {
    await openForm(page);
    await fill(page, GUEST.email, 'curta1');
    await submit(page).click();
    const alert = page.getByRole('alert');
    await expect(alert).toContainText('A senha precisa ter ao menos 10 caracteres.');
    await expect(password(page)).toBeFocused();
    await expect(password(page)).toHaveAttribute('aria-invalid', 'true');

    await fill(page, GUEST.email, STRONG, 'Outra-senha-longa-1!');
    await submit(page).click();
    // Uma indicação só, a do campo: a faixa de cima sai de cena (ela é para o erro que vem da API).
    await expect(page.locator('#invite-confirmation-status')).toHaveText(
      'As senhas ainda não são iguais.',
    );
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(confirmation(page)).toBeFocused();
    await expect(confirmation(page)).toHaveAttribute('aria-invalid', 'true');
    await expect(confirmation(page)).toHaveAttribute(
      'aria-describedby',
      'invite-confirmation-status',
    );
    expect(mock.requests.some((r) => r.path === '/guest-invites/accept')).toBe(false);
  });

  test('apertar o botão com a confirmação errada não perde o clique (a tela não se mexe sob o dedo)', async ({
    page,
  }) => {
    await openForm(page);
    await fill(page, GUEST.email, STRONG, 'Outra-senha-longa-1!');
    // No iPhone o botão está abaixo da dobra: rola até ele antes de medir onde apertar.
    await submit(page).scrollIntoViewIfNeeded();
    const box = (await submit(page).boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    // O tempo de um toque de verdade: se o campo perdesse o foco aqui, o aviso de divergência empurraria o botão.
    await page.waitForTimeout(300);
    await page.mouse.up();
    await expect(page.locator('#invite-confirmation-status')).toHaveText(
      'As senhas ainda não são iguais.',
    );
  });

  test('e-mail sem forma de e-mail: aviso no campo e foco nele', async ({ page }) => {
    await openForm(page);
    await fill(page, 'ana');
    await submit(page).click();
    await expect(page.locator('#invite-email-error')).toContainText('Confira o e-mail');
    await expect(email(page)).toBeFocused();
    expect(mock.requests.some((r) => r.path === '/guest-invites/accept')).toBe(false);
  });

  test('e-mail já em uso (409): o campo de e-mail volta com o foco e o aviso, e o convite continua valendo', async ({
    page,
  }) => {
    await openForm(page);
    await fill(page, OWNER.email);
    await submit(page).click();
    await expect(page.getByRole('alert')).toContainText('Este e-mail não pode ser usado.');
    await expect(page.getByRole('alert')).toContainText('O seu convite continua valendo');
    await expect(page.locator('#invite-email-error')).toHaveText('Escolha outro e-mail.');
    await expect(email(page)).toBeFocused();
    await expect(email(page)).toHaveAttribute('aria-invalid', 'true');
    await expect(
      page.getByRole('heading', { level: 1, name: 'Criar conta', exact: true }),
    ).toBeVisible();

    await email(page).fill(GUEST.email);
    await expect(page.locator('#invite-email-error')).toHaveCount(0);
    await submit(page).click();
    await expect(page).toHaveURL(/\/tv$/, { timeout: 8_000 });
  });
});

test.describe('convite: estados dedicados', () => {
  test('convite que não vale mais (410): título, o que fazer (lido junto) e a saída', async ({
    page,
  }) => {
    await openForm(page, UNKNOWN_LINK);
    await fill(page);
    await submit(page).click();
    await expect(
      page.getByRole('heading', { level: 1, name: 'Este convite não vale mais' }),
    ).toBeVisible();
    // O que fazer fica dentro do bloco anunciado, para o leitor de tela ouvir o motivo e a saída juntos.
    await expect(page.getByRole('alert')).toContainText('Peça um novo link a quem convidou você.');
    await expect(page.getByText('Peça um novo link a quem convidou você.')).toBeVisible();
    await expect(page).toHaveURL(/\/convite$/);
    await expect(page.getByRole('main').locator('form')).toHaveCount(0);
    await page.getByRole('link', { name: 'Já tenho conta: entrar' }).click();
    await expect(page).toHaveURL(/\/entrar$/);
  });

  test('endereço sem convite', async ({ page }) => {
    await page.goto('/convite');
    await expect(
      page.getByRole('heading', { level: 1, name: 'Convite não encontrado' }),
    ).toBeVisible();
    await expect(page.getByRole('alert')).toContainText('Abra o link do convite');
    await expect(page.getByRole('link', { name: 'Já tenho conta: entrar' })).toBeVisible();
  });

  test('link fora do padrão: nunca ecoa o que veio no endereço', async ({ page }) => {
    await page.goto('/convite#curto');
    await expect(page.getByRole('heading', { level: 1, name: 'Convite incompleto' })).toBeVisible();
    await expect(page).toHaveURL(/\/convite$/);
    expect(await page.evaluate(() => document.body.innerText)).not.toContain('curto');
  });

  test('colar o link certo na mesma aba (só o fragmento muda) abre o formulário', async ({
    page,
  }) => {
    await page.goto('/convite');
    await expect(
      page.getByRole('heading', { level: 1, name: 'Convite não encontrado' }),
    ).toBeVisible();
    await page.goto(`/convite#${mock.seedInvite().token}`);
    await expect(
      page.getByRole('heading', { level: 1, name: 'Criar conta', exact: true }),
    ).toBeVisible();
    await expect(page).toHaveURL(/\/convite$/);
  });

  test('limite de tentativas (429): explica, conta a espera e tranca o botão', async ({ page }) => {
    await failWith(page, '/guest-invites/accept', 429, 'rate-limited', { 'retry-after': '45' });
    await openForm(page);
    await fill(page);
    await submit(page).click();
    await expect(page.getByRole('alert')).toContainText('Muitas tentativas seguidas');
    await expect(page.locator('.wait-time')).toHaveText(/^\d:\d{2}$/);
    await expect(submit(page)).toBeDisabled();
  });

  test('sem rede e erro do servidor: avisam e mantêm o que foi digitado', async ({ page }) => {
    await openForm(page);
    await fill(page);
    await dropConnection(page, '/guest-invites/accept');
    await submit(page).click();
    await expect(page.getByRole('alert')).toContainText('Sem conexão com o servidor');
    await expect(password(page)).toHaveValue(STRONG);
    await expect(submit(page)).toBeEnabled();

    await page.unroute('**/api/v1/identity/guest-invites/accept');
    await failWith(page, '/guest-invites/accept', 500, 'internal');
    await submit(page).click();
    await expect(page.getByRole('alert')).toContainText('Não foi possível criar a conta agora');
    await expect(password(page)).toHaveValue(STRONG);
  });
});

test.describe('convite: teclado virtual', () => {
  test('com a janela baixa, a confirmação em foco e o botão de criar continuam alcançáveis', async ({
    page,
  }) => {
    await openForm(page);
    await confirmation(page).focus();
    const width = page.viewportSize()!.width;
    await page.setViewportSize({ width, height: 320 });
    await expect(confirmation(page)).toBeInViewport({ ratio: 1 });
    await submit(page).scrollIntoViewIfNeeded();
    await expect(submit(page)).toBeInViewport({ ratio: 1 });
    await expectNoHorizontalScroll(page);
  });

  test('cabe sem rolagem lateral em paisagem baixa', async ({ page }) => {
    await openForm(page);
    await page.setViewportSize({ width: 844, height: 390 });
    await expectNoHorizontalScroll(page);
  });
});

test.describe('convite: acessibilidade (axe, qualquer gravidade)', () => {
  for (const scheme of ['light', 'dark'] as const) {
    test(`formulário vazio e preenchido no tema ${scheme}`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await openForm(page);
      await expectNoA11yViolations(page);
      await fill(page);
      await page.getByRole('button', { name: 'Mostrar senha', exact: true }).click();
      await expect(page.getByText('As senhas conferem.', { exact: true })).toBeVisible();
      await expectNoA11yViolations(page);
    });

    test(`recusas de campo e faixa de erro no tema ${scheme}`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await openForm(page);
      await fill(page, 'ana', 'curta1');
      await submit(page).click();
      await expect(page.locator('#invite-email-error')).toBeVisible();
      await expectNoA11yViolations(page);
      await fill(page, GUEST.email, STRONG, 'Outra-senha-longa-1!');
      await submit(page).click();
      await expect(page.locator('#invite-confirmation-status')).toHaveText(
        'As senhas ainda não são iguais.',
      );
      await expectNoA11yViolations(page);
    });

    test(`e-mail em uso (409) e sem rede no tema ${scheme}`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await openForm(page);
      await fill(page, OWNER.email);
      await submit(page).click();
      await expect(page.getByRole('alert')).toContainText('Este e-mail não pode ser usado.');
      await expectNoA11yViolations(page);

      // Sem rede, o aviso global da conexão aparece acima da tela: ele não pode criar violação.
      await email(page).fill(GUEST.email);
      await dropConnection(page, '/guest-invites/accept');
      await submit(page).click();
      await expect(page.getByRole('alert')).toContainText('Sem conexão com o servidor');
      await expect(page.locator('app-connectivity-banner .banner')).toBeVisible();
      await expectNoA11yViolations(page);
    });

    test(`estados dedicados no tema ${scheme}`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await page.goto('/convite');
      await expect(page.getByRole('alert')).toBeVisible();
      await expectNoA11yViolations(page);
      await openForm(page, UNKNOWN_LINK);
      await fill(page);
      await submit(page).click();
      await expect(
        page.getByRole('heading', { level: 1, name: 'Este convite não vale mais' }),
      ).toBeVisible();
      await expectNoA11yViolations(page);
    });

    test(`tudo pronto no tema ${scheme}`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      const gate = await gateScripts(page);
      await openForm(page);
      gate.hold();
      await fill(page);
      await submit(page).click();
      await expect(page.getByRole('heading', { level: 1, name: 'Tudo pronto' })).toBeVisible();
      await expectNoA11yViolations(page);
      gate.release();
    });
  }
});
