import { Page } from '@playwright/test';
import { expect, test } from '../fixtures';
import { installFakeEventSource, mockTvApi } from '../tv/tv-mock';
import { GUEST, IdentityMock, TV_CONTROL_ONLY, mockIdentityApi } from './identity-mock';

// A API é simulada pelas rotas do Playwright, que não enxergam o que passa pelo service worker.
test.use({ serviceWorkers: 'block' });

let mock: IdentityMock;

test.beforeEach(async ({ context, page }) => {
  mock = await mockIdentityApi(context);
  mock.loggedIn = true;
  await mockTvApi(context, mock);
  await installFakeEventSource(page);
  // O relógio da página é do teste: dá para passar o teto de 30 s da leitura da conta sem esperar de verdade.
  await page.clock.install();
});

/** Quantas vezes o app leu a conta (`GET /me`) até agora. */
const meReads = () => mock.requests.filter((r) => r.method === 'GET' && r.path === '/me').length;

/** A linha da lista "O que você pode fazer" que a Perfil monta a partir das permissões da sessão. */
const powerAbility = (page: Page) =>
  page.getByRole('listitem').filter({ hasText: 'Desligar a TV' });

/** A aba volta para o primeiro plano (o navegador dispara este evento no documento). */
const comeBack = (page: Page) =>
  page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));

/**
 * Espera uma ida e volta à API: um pedido que o app tivesse feito antes dela já foi visto pelo simulador. Serve para
 * afirmar que NADA foi pedido, sem esperar um tempo fixo.
 */
const roundTrip = (page: Page) => page.evaluate(() => fetch('/api/v1/identity/info').then(() => 0));

test('the permissions on screen follow the server when the app returns to the foreground, without a reload', async ({
  page,
}) => {
  mock.guests.push({
    id: '00000000-0000-4000-8000-000000000051',
    displayName: GUEST.displayName,
    email: GUEST.email,
    password: GUEST.password,
    createdAt: '2026-10-19T15:00:00Z',
    disabledAt: null,
  });
  mock.role = 'guest';
  const guest = mock.guests.at(-1)!;

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/ajustes/perfil');
  await expect(page.getByRole('heading', { level: 1, name: 'Perfil' })).toBeVisible();
  await expect(powerAbility(page)).toBeVisible();
  // Prova de que a página não recarrega: o que se põe na janela agora só sobrevive sem recarga.
  await page.evaluate(() => {
    (window as unknown as Record<string, unknown>)['sessionRefreshMarker'] = true;
  });
  const reads = meReads();

  // O administrador tira "desligar a TV" desta pessoa (o servidor passa a recusar).
  guest.permissions = TV_CONTROL_ONLY.filter((permission) => permission !== 'tv:power');

  // Voltar para a tela logo em seguida não relê: a última leitura tem menos de 30 s (o servidor também só reavalia a cada 30 s).
  await comeBack(page);
  await roundTrip(page);
  expect(meReads()).toBe(reads);
  await expect(powerAbility(page)).toBeVisible();

  // Passado o teto, voltar para a tela relê a conta uma vez e a lista se corrige sozinha.
  await page.clock.fastForward('00:31');
  await comeBack(page);
  await expect.poll(meReads).toBe(reads + 1);
  await expect(powerAbility(page)).toHaveCount(0);
  await expect(page.getByRole('listitem').filter({ hasText: 'Controlar a TV' })).toBeVisible();
  expect(
    await page.evaluate(
      () => (window as unknown as Record<string, unknown>)['sessionRefreshMarker'],
    ),
  ).toBe(true);

  // O teto recomeça dessa leitura: nova volta logo depois não pede nada.
  await comeBack(page);
  await roundTrip(page);
  expect(meReads()).toBe(reads + 1);
});
