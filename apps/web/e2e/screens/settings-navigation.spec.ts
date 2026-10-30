import { IdentityMock, mockIdentityApi } from '../auth/identity-mock';
import { mockDevicesApi } from '../devices/devices-mock';
import { expect, test } from '../fixtures';
import { installFakeEventSource, mockTvApi } from '../tv/tv-mock';

// A API é simulada pelas rotas do Playwright, que não enxergam o que passa pelo service worker.
test.use({ serviceWorkers: 'block' });

/** Cada seção de Configurações do administrador: a linha na lista, o endereço e o título do cabeçalho. */
const SECTIONS = [
  { row: /^Perfil/, path: '/ajustes/perfil', title: 'Perfil' },
  { row: /^Aparência/, path: '/ajustes/aparencia', title: 'Aparência' },
  { row: /^Segurança/, path: '/ajustes/seguranca', title: 'Segurança' },
  { row: /^Pessoas e Permissões/, path: '/ajustes/pessoas', title: 'Pessoas e Permissões' },
  { row: /^Dispositivos/, path: '/ajustes/dispositivos', title: 'Dispositivos' },
  { row: /^Sistema/, path: '/ajustes/sistema', title: 'Sistema' },
  { row: /^Auditoria/, path: '/ajustes/auditoria', title: 'Auditoria' },
  { row: /^Sobre/, path: '/ajustes/sobre', title: 'Sobre' },
] as const;

const BACK_TO_SETTINGS = 'Voltar às Configurações';

let mock: IdentityMock;

test.beforeEach(async ({ context, page }) => {
  await page.addInitScript(() => {
    if (!('PublicKeyCredential' in window)) {
      Object.defineProperty(window, 'PublicKeyCredential', { value: class {}, configurable: true });
    }
    if (!navigator.credentials) {
      Object.defineProperty(navigator, 'credentials', {
        value: { get: async () => null, create: async () => null },
        configurable: true,
      });
    }
  });
  mock = await mockIdentityApi(context);
  mock.loggedIn = true;
  await mockTvApi(context, mock);
  await mockDevicesApi(context, mock);
  await installFakeEventSource(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
});

/** O cabeçalho da tela: um título numa linha e um único voltar, que leva ao pai lógico. */
async function expectStandardHeader(page: import('@playwright/test').Page, title: string) {
  const heading = page.getByRole('heading', { level: 1, name: title });
  await expect(heading).toBeVisible();
  // Título numa linha: a altura da caixa não passa de uma linha de texto.
  const box = (await heading.boundingBox())!;
  const lineHeight = await heading.evaluate((el) => parseFloat(getComputedStyle(el).lineHeight));
  expect(box.height, `o título "${title}" cabe numa linha`).toBeLessThanOrEqual(lineHeight + 2);
  // Um único voltar: o do cabeçalho; nenhuma tela traz outro dentro do conteúdo.
  await expect(page.getByRole('button', { name: BACK_TO_SETTINGS })).toHaveCount(1);
  await expect(page.locator('main .back')).toHaveCount(0);
}

test.describe('navegação padrão de Configurações', () => {
  test('Início → Configurações → cada seção → voltar leva à lista; da lista, à Início', async ({
    page,
  }) => {
    await page.goto('/');
    await page.getByRole('link', { name: 'Configurações' }).first().click();
    await expect(page).toHaveURL(/\/ajustes$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Configurações' })).toBeVisible();

    for (const section of SECTIONS) {
      await page.getByRole('link', { name: section.row }).click();
      await expect(page).toHaveURL(new RegExp(`${section.path}$`));
      await expectStandardHeader(page, section.title);

      await page.getByRole('button', { name: BACK_TO_SETTINGS }).click();
      await expect(page, `o voltar de ${section.title} leva à lista`).toHaveURL(/\/ajustes$/);
      await expect(page.getByRole('heading', { level: 1, name: 'Configurações' })).toBeVisible();
    }

    // Da lista, o voltar leva à Início (e é o único).
    await expect(page.getByRole('button', { name: 'Voltar ao Início' })).toHaveCount(1);
    await page.getByRole('button', { name: 'Voltar ao Início' }).click();
    await expect(page).toHaveURL(/\/$/);
  });

  test('por link direto e depois de recarregar, o voltar continua levando à lista', async ({
    page,
  }) => {
    for (const section of SECTIONS) {
      await page.goto(section.path);
      await expectStandardHeader(page, section.title);

      await page.reload();
      await expectStandardHeader(page, section.title);

      await page.getByRole('button', { name: BACK_TO_SETTINGS }).click();
      await expect(page, `${section.title}: voltar depois de recarregar`).toHaveURL(/\/ajustes$/);
    }
  });

  test('a lista recarregada ainda volta à Início', async ({ page }) => {
    await page.goto('/ajustes');
    await page.reload();
    await page.getByRole('button', { name: 'Voltar ao Início' }).click();
    await expect(page).toHaveURL(/\/$/);
  });

  test('o endereço antigo de Aparelhos leva a Dispositivos', async ({ page }) => {
    await page.goto('/ajustes/aparelhos');
    await expect(page).toHaveURL(/\/ajustes\/dispositivos$/);
    await expectStandardHeader(page, 'Dispositivos');
  });
});
