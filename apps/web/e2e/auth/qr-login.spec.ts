import AxeBuilder from '@axe-core/playwright';
import { Browser, BrowserContext, Page } from '@playwright/test';
import { expect, expectNoHorizontalScroll, screenshot, test } from '../fixtures';
import { GUEST, IdentityMock, QrServerMock, mockIdentityApi, newQrServer } from './identity-mock';

// A API é simulada pelas rotas do Playwright, que não enxergam o que passa pelo service worker.
test.use({ serviceWorkers: 'block' });

const WINDOWS_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const IPHONE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const GUEST_ID = '00000000-0000-4000-8000-000000000051';

function seriousViolations(violations: { id: string; impact?: string | null }[]) {
  return violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => v.id);
}

/** O computador de quem quer entrar: janela larga, mouse, agente do Windows (o bloco do QR só aparece assim). */
const desktop = {
  userAgent: WINDOWS_UA,
  viewport: { width: 1280, height: 800 },
  isMobile: false,
  hasTouch: false,
} as const;

interface Phone {
  readonly context: BrowserContext;
  readonly page: Page;
  readonly identity: IdentityMock;
}

/** O celular da pessoa: outro contexto (outra sessão, outro cookie), com a conta do convidado já logada e o servidor do QR compartilhado. */
async function openPhone(
  browser: Browser,
  qr: QrServerMock,
  loggedIn: boolean,
  role: 'guest' | 'owner' = 'guest',
): Promise<Phone> {
  const context = await browser.newContext({
    userAgent: IPHONE_UA,
    viewport: { width: 390, height: 664 },
    isMobile: true,
    hasTouch: true,
    serviceWorkers: 'block',
  });
  // A dica "Atalho na tela de início" abriria sozinha neste agente de iPhone e deixaria a página inerte (ver `fixtures`).
  await context.addInitScript(() => {
    try {
      for (const key of ['', '.tv', '.treino']) {
        localStorage.setItem(`uniover.install-hint.v1${key}`, JSON.stringify({ never: true }));
      }
    } catch {
      // Sem armazenamento a dica também não se lembra de nada.
    }
  });
  const identity = await mockIdentityApi(context, { qr });
  if (role === 'guest') {
    identity.guests.push({
      id: GUEST_ID,
      displayName: GUEST.displayName,
      email: GUEST.email,
      password: GUEST.password,
      createdAt: '2026-10-19T15:00:00Z',
      disabledAt: null,
      permissions: ['module:tv', 'module:training'],
    });
  }
  identity.role = role;
  identity.loggedIn = loggedIn;
  const page = await context.newPage();
  return { context, page, identity };
}

test.describe('computador: o bloco "Entrar com o celular"', () => {
  test.use(desktop);

  let qr: QrServerMock;
  let pc: IdentityMock;

  test.beforeEach(async ({ context }) => {
    qr = newQrServer();
    pc = await mockIdentityApi(context, { qr });
  });

  test('mostra o QR na tela de entrar, com o texto curto e sem rolagem lateral', async ({
    page,
  }, info) => {
    await page.goto('/entrar?next=%2Fconectar');

    await expect(
      page.getByRole('heading', { level: 2, name: 'Entrar com o celular' }),
    ).toBeVisible();
    const code = page.getByRole('img', { name: 'QR para entrar pelo celular' });
    await expect(code).toBeVisible();
    await expect(code.locator('path')).toHaveAttribute('d', /^M\d+ \d+h\d+v1h-\d+z/);
    await expect(page.getByText('Escaneie com o celular onde você já entrou.')).toBeVisible();
    // O segredo de consulta só existe na memória da página: nunca no desenho, na URL nem no texto.
    const secret = qr.requests[0].secret;
    expect(await page.content()).not.toContain(secret);
    expect(page.url()).not.toContain(secret);
    await expectNoHorizontalScroll(page);

    // O QR é quadrado e tem um tamanho que um celular lê de um monitor.
    const box = (await code.boundingBox())!;
    expect(Math.abs(box.width - box.height)).toBeLessThan(2);
    expect(box.width).toBeGreaterThanOrEqual(160);

    await screenshot(page, info.outputPath('pc-entrar-qr.png'), { fullPage: true });
  });

  test('não tem violação séria de acessibilidade', async ({ page }) => {
    await page.goto('/entrar');
    await expect(page.getByRole('img', { name: 'QR para entrar pelo celular' })).toBeVisible();

    const results = await new AxeBuilder({ page }).analyze();

    expect(seriousViolations(results.violations)).toEqual([]);
  });

  test('o celular confirma e o computador entra sozinho, seguindo para o destino', async ({
    page,
    browser,
  }, info) => {
    const phone = await openPhone(browser, qr, true);
    await page.goto('/entrar?next=%2Fconectar');
    await expect(page.getByRole('img', { name: 'QR para entrar pelo celular' })).toBeVisible();

    const entry = qr.requests[0];
    await phone.page.goto(`/entrar/qr?codigo=${entry.code}`);
    await expect(
      phone.page.getByRole('heading', { level: 1, name: 'Entrar no computador?' }),
    ).toBeVisible();
    await expect(phone.page.getByText('Chrome no Windows')).toBeVisible();
    await expect(phone.page.getByText('Na mesma rede deste celular')).toBeVisible();
    await expect(phone.page.getByText('Confirme só se foi você quem abriu o QR.')).toBeVisible();
    await expectNoHorizontalScroll(phone.page);
    for (const name of ['Confirmar', 'Cancelar']) {
      const box = (await phone.page.getByRole('button', { name, exact: true }).boundingBox())!;
      expect(box.height).toBeGreaterThanOrEqual(44);
    }
    await screenshot(phone.page, info.outputPath('celular-confirmar.png'));

    await phone.page.getByRole('button', { name: 'Confirmar', exact: true }).click();
    await expect(
      phone.page.getByRole('heading', { level: 1, name: 'Computador liberado' }),
    ).toBeVisible();
    await screenshot(phone.page, info.outputPath('celular-liberado.png'));

    // O computador consulta, recebe a sessão e vai para o destino (sem digitar nada).
    await expect(page).toHaveURL(/\/conectar$/, { timeout: 15_000 });
    expect(pc.loggedIn).toBe(true);
    expect(entry.status).toBe('consumed');
    // Ninguém digitou senha neste computador.
    expect(pc.requests.some((r) => r.path === '/auth/login')).toBe(false);
    await expect(page.getByRole('img', { name: 'QR para entrar pelo celular' })).toHaveCount(0);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await screenshot(page, info.outputPath('pc-logado.png'), { fullPage: true });
    await phone.context.close();
  });

  test('a conta que entrou pelo QR é a do celular, com o papel dela', async ({ page, browser }) => {
    const phone = await openPhone(browser, qr, true, 'guest');
    await page.goto('/entrar');
    await expect(page.getByRole('img', { name: 'QR para entrar pelo celular' })).toBeVisible();
    await phone.page.goto(`/entrar/qr?codigo=${qr.requests[0].code}`);
    await phone.page.getByRole('button', { name: 'Confirmar', exact: true }).click();

    await expect.poll(() => pc.role, { timeout: 15_000 }).toBe('guest');
    await expect.poll(() => pc.loggedIn, { timeout: 15_000 }).toBe(true);
    await phone.context.close();
  });

  test('recusado no celular, o computador avisa e oferece outro QR', async ({
    page,
    browser,
  }, info) => {
    const phone = await openPhone(browser, qr, true);
    await page.goto('/entrar');
    await expect(page.getByRole('img', { name: 'QR para entrar pelo celular' })).toBeVisible();
    await phone.page.goto(`/entrar/qr?codigo=${qr.requests[0].code}`);

    await phone.page.getByRole('button', { name: 'Cancelar', exact: true }).click();
    await expect(
      phone.page.getByRole('heading', { level: 1, name: 'Entrada cancelada' }),
    ).toBeVisible();

    await expect(page.getByText('Recusado no celular.')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('img', { name: 'QR para entrar pelo celular' })).toHaveCount(0);
    expect(pc.loggedIn).toBe(false);
    await screenshot(page, info.outputPath('pc-recusado.png'));

    await page.getByRole('button', { name: 'Gerar outro QR' }).click();
    await expect(page.getByRole('img', { name: 'QR para entrar pelo celular' })).toBeVisible();
    expect(qr.requests).toHaveLength(2);
    await phone.context.close();
  });

  test('o QR se renova sozinho antes de vencer, com código e segredo novos', async ({ page }) => {
    qr.expiresIn = 6; // a tela troca o QR 5 s antes do fim: aqui, na primeira consulta
    await page.goto('/entrar');
    await expect(page.getByRole('img', { name: 'QR para entrar pelo celular' })).toBeVisible();

    await expect.poll(() => qr.requests.length, { timeout: 15_000 }).toBeGreaterThanOrEqual(2);
    expect(qr.requests[1].code).not.toBe(qr.requests[0].code);
    expect(qr.requests[1].secret).not.toBe(qr.requests[0].secret);
    await expect(page.getByRole('img', { name: 'QR para entrar pelo celular' })).toBeVisible();
  });

  test('um QR que já foi confirmado não vale de novo no celular', async ({ page, browser }) => {
    const phone = await openPhone(browser, qr, true);
    await page.goto('/entrar');
    await expect(page.getByRole('img', { name: 'QR para entrar pelo celular' })).toBeVisible();
    const code = qr.requests[0].code;
    await phone.page.goto(`/entrar/qr?codigo=${code}`);
    await phone.page.getByRole('button', { name: 'Confirmar', exact: true }).click();
    await expect(phone.page.getByRole('heading', { name: 'Computador liberado' })).toBeVisible();

    await phone.page.goto(`/entrar/qr?codigo=${code}`);
    await expect(phone.page.getByRole('heading', { level: 1, name: 'QR vencido' })).toBeVisible();
    await phone.context.close();
  });

  test('também aparece na página pública /conectar, e some depois de entrar', async ({
    page,
    browser,
  }, info) => {
    const phone = await openPhone(browser, qr, true);
    await page.goto('/conectar');
    await expect(
      page.getByRole('heading', { level: 2, name: 'Entrar com o celular' }),
    ).toBeVisible();
    await expect(page.getByRole('img', { name: 'QR para entrar pelo celular' })).toBeVisible();
    await screenshot(page, info.outputPath('pc-conectar-qr.png'), { fullPage: true });

    await phone.page.goto(`/entrar/qr?codigo=${qr.requests[0].code}`);
    await phone.page.getByRole('button', { name: 'Confirmar', exact: true }).click();

    // Na página pública não há para onde seguir: ela fica e mostra que a pessoa entrou.
    await expect(page.getByText('Pronto, entrando…')).toBeVisible({ timeout: 15_000 });
    await expect(page).toHaveURL(/\/conectar$/);
    expect(pc.loggedIn).toBe(true);
    await phone.context.close();
  });

  test('quem já tem sessão neste computador não vê o bloco nem pede QR', async ({ page }) => {
    pc.loggedIn = true;
    await page.goto('/entrar');

    await expect(page).not.toHaveURL(/\/entrar/);
    expect(pc.requests.some((r) => r.path === '/auth/qr/start')).toBe(false);
  });
});

test.describe('celular: a tela de confirmar', () => {
  let qr: QrServerMock;

  test.beforeEach(() => {
    qr = newQrServer();
  });

  /** Um pedido aberto por "um computador" qualquer. */
  function seedRequest(): string {
    qr.requests.push({
      code: 'Qr1aaaaaaaaaaaaa',
      secret: 'segredo-do-pc',
      userAgent: WINDOWS_UA,
      status: 'pending',
    });
    return qr.requests[0].code;
  }

  test('sem sessão, passa pelo login e volta à confirmação com o código', async ({
    browser,
  }, info) => {
    const code = seedRequest();
    const phone = await openPhone(browser, qr, false);

    await phone.page.goto(`/entrar/qr?codigo=${code}`);
    await expect(phone.page).toHaveURL(/\/entrar\?next=/);
    await expect(
      phone.page.getByRole('heading', { level: 1, name: 'Entrar', exact: true }),
    ).toBeVisible();
    // No celular o bloco do QR não aparece: não há como escanear a própria tela.
    await expect(phone.page.getByRole('heading', { name: 'Entrar com o celular' })).toHaveCount(0);
    expect(phone.identity.requests.some((r) => r.path === '/auth/qr/start')).toBe(false);

    await phone.page.getByLabel('E-mail').fill(GUEST.email);
    await phone.page.getByLabel('Senha', { exact: true }).fill(GUEST.password);
    await phone.page.getByRole('button', { name: 'Entrar', exact: true }).click();

    await expect(phone.page).toHaveURL(new RegExp(`/entrar/qr\\?codigo=${code}`));
    await expect(
      phone.page.getByRole('heading', { level: 1, name: 'Entrar no computador?' }),
    ).toBeVisible();
    await screenshot(phone.page, info.outputPath('celular-depois-do-login.png'));
    await phone.context.close();
  });

  test('sessão antiga e sem passkey: pede a senha, recusa a errada e aceita a certa', async ({
    browser,
  }, info) => {
    const code = seedRequest();
    qr.verification = 'password';
    qr.sameNetwork = false;
    const phone = await openPhone(browser, qr, true);
    await phone.page.goto(`/entrar/qr?codigo=${code}`);

    await expect(phone.page.getByText('Em outra rede')).toBeVisible();
    await expect(phone.page.locator('li.warn')).toBeVisible();
    const password = phone.page.getByLabel('Senha', { exact: true });
    await expect(password).toBeVisible();
    await screenshot(phone.page, info.outputPath('celular-senha.png'));

    // Sem senha: o aviso aparece e nada é enviado.
    await phone.page.getByRole('button', { name: 'Confirmar', exact: true }).click();
    await expect(phone.page.getByText('Informe a sua senha.')).toBeVisible();
    expect(phone.identity.requests.some((r) => r.path === '/auth/qr/approve')).toBe(false);

    await password.fill('senha-errada-123');
    await phone.page.getByRole('button', { name: 'Confirmar', exact: true }).click();
    await expect(phone.page.getByText('Senha incorreta.')).toBeVisible();
    expect(qr.requests[0].status).toBe('pending');

    await password.fill(GUEST.password);
    await phone.page.getByRole('button', { name: 'Confirmar', exact: true }).click();
    await expect(phone.page.getByRole('heading', { name: 'Computador liberado' })).toBeVisible();
    expect(qr.requests[0].status).toBe('approved');
    await phone.context.close();
  });

  test('com passkey, a confirmação abre o diálogo da passkey e, cancelada, nada é liberado', async ({
    browser,
  }, info) => {
    const code = seedRequest();
    qr.verification = 'passkey';
    const phone = await openPhone(browser, qr, true, 'owner');
    phone.identity.passkeys.push({
      id: 'p1',
      name: 'Celular',
      rawId: 'cmF3',
      createdAt: '2026-10-19T12:00:00Z',
      lastUsedAt: null,
    });
    await phone.page.goto(`/entrar/qr?codigo=${code}`);

    await phone.page.getByRole('button', { name: 'Confirmar', exact: true }).click();
    const dialog = phone.page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('liberar a entrada de um computador');
    await screenshot(phone.page, info.outputPath('celular-passkey.png'));

    await dialog.getByRole('button', { name: 'Cancelar' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(phone.page.getByRole('button', { name: 'Confirmar', exact: true })).toBeEnabled();
    expect(qr.requests[0].status).toBe('pending');
    await phone.context.close();
  });

  test('QR vencido, sem código ou sem conexão: um aviso curto, sem botão de confirmar', async ({
    browser,
  }, info) => {
    const phone = await openPhone(browser, qr, true);

    await phone.page.goto('/entrar/qr?codigo=Qr9aaaaaaaaaaaaa');
    await expect(phone.page.getByRole('heading', { level: 1, name: 'QR vencido' })).toBeVisible();
    await expect(phone.page.getByText('Peça outro na tela do computador.')).toBeVisible();
    await expect(phone.page.getByRole('button', { name: 'Confirmar' })).toHaveCount(0);
    await screenshot(phone.page, info.outputPath('celular-vencido.png'));

    await phone.page.goto('/entrar/qr');
    await expect(phone.page.getByRole('heading', { level: 1, name: 'QR vencido' })).toBeVisible();
    await phone.context.close();
  });

  test('a tela de confirmar não tem violação séria de acessibilidade', async ({ browser }) => {
    const code = seedRequest();
    qr.verification = 'password';
    const phone = await openPhone(browser, qr, true);
    await phone.page.goto(`/entrar/qr?codigo=${code}`);
    await expect(phone.page.getByLabel('Senha', { exact: true })).toBeVisible();

    const results = await new AxeBuilder({ page: phone.page }).analyze();

    expect(seriousViolations(results.violations)).toEqual([]);
    await phone.context.close();
  });
});
