import { Page } from '@playwright/test';
import { GUEST, IdentityMock, OWNER, mockIdentityApi } from '../auth/identity-mock';
import { expect, expectNoHorizontalScroll, test } from '../fixtures';
import { HOT_STATE, TvMock, emitSse, installFakeEventSource, mockTvApi, sseUrls } from './tv-mock';

// A API é simulada pelas rotas do Playwright, que não enxergam o que passa pelo service worker.
test.use({ serviceWorkers: 'block' });

// O pareamento é verificado no iPhone 12 (Safari), o aparelho de quem usa a TV; o outro projeto não repete.
test.beforeEach(({}, info) => {
  test.skip(info.project.name !== 'iphone-12', 'só no projeto iphone-12');
});

const NOT_PAIRED = { ...HOT_STATE, connection: 'not_paired' };
const CODE = 'A1B2C3';

let identity: IdentityMock;
let tv: TvMock;

test.beforeEach(async ({ context, page }) => {
  identity = await mockIdentityApi(context);
  tv = await mockTvApi(context, identity);
  tv.state = { ...NOT_PAIRED };
  await installFakeEventSource(page);
});

/** Entra como dono, abre /tv e entrega o estado `not_paired` que a API manda ao abrir o fluxo. */
async function openUnpairedTv(page: Page, account: { email: string; password: string } = OWNER) {
  await page.goto('/entrar');
  await page.getByLabel('E-mail').fill(account.email);
  await page.getByLabel('Senha', { exact: true }).fill(account.password);
  await page.getByRole('button', { name: 'Entrar', exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
  await page.goto('/tv');
  await expect.poll(() => sseUrls(page)).toEqual(['/api/v1/tv/events']);
  await emitSse(page, 'tv.state', NOT_PAIRED);
  await emitSse(page, 'tv.shortcuts', tv.shortcuts);
}

const section = (page: Page) => page.locator('.pairing');
const sheet = (page: Page) => page.locator('app-tv-pair-sheet dialog');

test.describe('TV não pareada', () => {
  test('mostra o estado e só abre o pareamento no toque do dono, sem falar com a TV antes', async ({
    page,
  }) => {
    await openUnpairedTv(page);

    await expect(section(page).getByRole('heading', { name: 'TV não pareada' })).toBeVisible();
    // Nada abre sozinho nem pede o código: o dono é quem decide.
    await expect(sheet(page)).toHaveCount(0);
    expect(tv.count('/pair')).toBe(0);
    await expectNoHorizontalScroll(page);

    await section(page).getByRole('button', { name: 'Parear de novo' }).click();
    await expect(sheet(page)).toBeVisible();
    await expect(sheet(page).getByRole('heading', { name: 'Parear a TV' })).toBeVisible();
    // A folha só explica: o código só sai da TV quando o dono toca em "Mostrar Código".
    expect(tv.count('/pair')).toBe(0);
    await expectNoHorizontalScroll(page);
  });

  test('pareia em dois passos, tira o aviso da tela e o código nunca vai para a URL', async ({
    page,
  }) => {
    await openUnpairedTv(page);
    await section(page).getByRole('button', { name: 'Parear de novo' }).click();

    await sheet(page).getByRole('button', { name: 'Mostrar Código' }).click();
    const field = sheet(page).getByLabel('Digite o código que aparece na TV.');
    await expect(field).toBeVisible();
    expect(tv.pairBodies()).toEqual([{}]);

    const confirm = sheet(page).getByRole('button', { name: 'Parear', exact: true });
    await expect(confirm).toBeDisabled();
    await field.fill('a1b2c3');
    await expect(field).toHaveValue(CODE);
    await expect(confirm).toBeEnabled();
    await expectNoHorizontalScroll(page);
    await confirm.click();

    await expect(sheet(page).getByText('TV pareada. O controle volta em instantes.')).toBeVisible();
    expect(tv.pairBodies()).toEqual([{}, { code: CODE }]);
    expect(tv.requests.filter((r) => r.path === '/pair').every((r) => !r.tvId)).toBe(true);
    // O código sumiu da folha assim que foi usado.
    await expect(sheet(page).locator('input')).toHaveCount(0);

    // O agente reabre a sessão e a API manda o estado novo: o aviso sai sozinho.
    await emitSse(page, 'tv.state', { ...HOT_STATE });
    await expect(section(page)).toHaveCount(0);
    await sheet(page).getByRole('button', { name: 'Pronto' }).click();
    await expect(sheet(page)).toHaveCount(0);
  });

  test('um código recusado pede outro e só recomeça por um novo toque', async ({ page }) => {
    tv.pairAnswer = 'refused';
    await openUnpairedTv(page);
    await section(page).getByRole('button', { name: 'Parear de novo' }).click();
    await sheet(page).getByRole('button', { name: 'Mostrar Código' }).click();
    await sheet(page).getByLabel('Digite o código que aparece na TV.').fill(CODE);
    await sheet(page).getByRole('button', { name: 'Parear', exact: true }).click();

    await expect(
      sheet(page).getByText('O código não serviu ou venceu. Peça outro à TV.'),
    ).toBeVisible();
    // A TV segue não pareada e nada recomeçou sozinho: dois pedidos até aqui (o código e a entrega).
    expect(tv.pairBodies()).toEqual([{}, { code: CODE }]);
    await expect(section(page)).toBeVisible();

    await sheet(page).getByRole('button', { name: 'Tentar de Novo' }).click();
    await expect(sheet(page).getByLabel('Digite o código que aparece na TV.')).toBeVisible();
    expect(tv.pairBodies()).toEqual([{}, { code: CODE }, {}]);
  });

  test('com a TV fora do ar explica e deixa tentar de novo', async ({ page }) => {
    tv.pairAnswer = 'unreachable';
    await openUnpairedTv(page);
    await section(page).getByRole('button', { name: 'Parear de novo' }).click();
    await sheet(page).getByRole('button', { name: 'Mostrar Código' }).click();

    await expect(
      sheet(page).getByText('A TV não respondeu. Ligue-a e tente de novo.'),
    ).toBeVisible();
    await expect(sheet(page).getByRole('button', { name: 'Tentar de Novo' })).toBeVisible();
    await sheet(page).getByRole('button', { name: 'Fechar' }).click();
    await expect(sheet(page)).toHaveCount(0);
  });

  test('um convidado não vê o botão e nada chega ao pareamento', async ({ page }) => {
    identity.guests.push({
      id: '00000000-0000-4000-8000-000000000061',
      displayName: GUEST.displayName,
      email: GUEST.email,
      password: GUEST.password,
      createdAt: '2026-10-19T15:00:00Z',
      disabledAt: null,
      permissions: ['module:tv', 'tv:control'],
    });
    identity.role = 'guest';
    await openUnpairedTv(page, GUEST);

    await expect(section(page)).toContainText('Peça a quem administra o app para parear a TV.');
    await expect(section(page).getByRole('button')).toHaveCount(0);
    expect(tv.count('/pair')).toBe(0);
  });
});
