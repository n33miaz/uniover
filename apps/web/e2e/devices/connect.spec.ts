import AxeBuilder from '@axe-core/playwright';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { GUEST, IdentityMock, OWNER, mockIdentityApi } from '../auth/identity-mock';
import {
  expect,
  expectNoHorizontalScroll,
  screenshot,
  test,
  waitForServiceWorkerControl,
} from '../fixtures';
import { settle } from '../screens/screen-helpers';
import { DevicesMock, mockDevicesApi } from './devices-mock';

const WINDOWS_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const DEEP_LINK = '/ajustes/dispositivos?codigo=bcdf2345';
const CONNECTOR_FILE = resolve(__dirname, '../../public/conectar/conectar-uniover.cmd');

// A API é simulada pelas rotas do Playwright, que não enxergam o que passa pelo service worker.
test.use({ serviceWorkers: 'block' });

let identity: IdentityMock;
let devices: DevicesMock;

test.beforeEach(async ({ context }) => {
  identity = await mockIdentityApi(context);
  devices = await mockDevicesApi(context, identity);
});

function seriousViolations(violations: { id: string; impact?: string | null }[]) {
  return violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => v.id);
}

test.describe('link do QR do agente', () => {
  test('logado, abre a folha com o código preenchido e tira o código do endereço', async ({
    page,
  }, info) => {
    identity.loggedIn = true;
    identity.stepUpValid = true; // a passkey tem teste próprio em devices.spec.ts
    devices.openCodes.add('BCDF2345');

    await page.goto(DEEP_LINK);
    const sheet = page.getByRole('dialog', { name: 'Parear dispositivo' });
    await expect(sheet).toBeVisible();
    await expect(sheet.getByLabel('Código do dispositivo')).toHaveValue('BCDF-2345');
    await expect(sheet.getByRole('button', { name: 'Aprovar' })).toBeEnabled();
    await expect(page).toHaveURL(/\/ajustes\/dispositivos$/);
    await expectNoHorizontalScroll(page);
    await settle(page);
    await screenshot(page, info.outputPath('deep-link.png'));

    await sheet.getByRole('button', { name: 'Aprovar' }).click();
    await expect(page.getByText('Dispositivo PC de casa pareado.')).toBeVisible();
    expect(devices.openCodes.size).toBe(0);
    await expect(page).toHaveURL(/\/ajustes\/dispositivos$/);
  });

  test('deslogado, passa pelo login e volta para a folha com o código', async ({ page }) => {
    identity.stepUpValid = true;
    devices.openCodes.add('BCDF2345');

    await page.goto(DEEP_LINK);
    await expect(page).toHaveURL(/\/entrar\?next=/);
    expect(decodeURIComponent(new URL(page.url()).searchParams.get('next') ?? '')).toBe(DEEP_LINK);

    await page.getByLabel('E-mail').fill(OWNER.email);
    await page.getByLabel('Senha', { exact: true }).fill(OWNER.password);
    await page.getByRole('button', { name: 'Entrar', exact: true }).click();

    const sheet = page.getByRole('dialog', { name: 'Parear dispositivo' });
    await expect(sheet).toBeVisible();
    await expect(sheet.getByLabel('Código do dispositivo')).toHaveValue('BCDF-2345');
    await expect(page).toHaveURL(/\/ajustes\/dispositivos$/);
  });

  test('conta sem permissão vê só o aviso, sem folha e sem chamar a API de dispositivos', async ({
    page,
  }, info) => {
    identity.guests.push({
      id: '00000000-0000-4000-8000-000000000051',
      displayName: GUEST.displayName,
      email: GUEST.email,
      password: GUEST.password,
      createdAt: '2026-10-19T15:00:00Z',
      disabledAt: null,
      permissions: ['module:training'],
    });
    identity.role = 'guest';
    identity.loggedIn = true;

    await page.goto(DEEP_LINK);
    await expect(page.getByText('Peça ao administrador para aprovar.')).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page).toHaveURL(/\/ajustes\/dispositivos$/);
    expect(devices.requests).toHaveLength(0);
    await expectNoHorizontalScroll(page);
    await settle(page);
    await screenshot(page, info.outputPath('no-permission.png'));
  });
});

test.describe('conectar este PC', () => {
  test.describe('no Windows', () => {
    test.use({ userAgent: WINDOWS_UA });

    test('abre a folha curta, baixa o conector e fecha por Esc e pelo fundo', async ({
      page,
    }, info) => {
      identity.loggedIn = true;
      await page.goto('/ajustes/dispositivos');
      await page.getByRole('button', { name: 'Conectar este PC' }).click();

      const sheet = page.getByRole('dialog', { name: 'Conectar este PC' });
      await expect(sheet).toBeVisible();
      await expect(sheet.getByRole('listitem')).toHaveText([
        'Baixar e abrir o conector',
        'Escanear o QR com o celular',
        'Aceitar na TV',
      ]);
      const link = sheet.getByRole('link', { name: 'Baixar conector' });
      await expect(link).toHaveAttribute('href', '/conectar/conectar-uniover.cmd');
      await expect(link).toHaveAttribute('download', 'conectar-uniover.cmd');
      const box = await link.boundingBox();
      expect(box!.height).toBeGreaterThanOrEqual(44);
      await expectNoHorizontalScroll(page);
      await settle(page);
      await screenshot(page, info.outputPath('connect-sheet.png'));
      const { violations } = await new AxeBuilder({ page }).analyze();
      expect(seriousViolations(violations)).toEqual([]);

      const [download] = await Promise.all([page.waitForEvent('download'), link.click()]);
      expect(download.suggestedFilename()).toBe('conectar-uniover.cmd');
      const bytes = await readFile((await download.path())!, 'utf8');
      // O arquivo baixado é o que está em public/: sem janela de console aberta e sem "pause".
      expect(bytes).toBe(await readFile(CONNECTOR_FILE, 'utf8'));
      expect(bytes).toContain('start "" wscript.exe //B //Nologo');
      expect(bytes).toContain('install-windows.ps1');
      expect(bytes).not.toMatch(/\bpause\b/i);
      // Baixar não fecha a folha: os passos seguem na tela.
      await expect(sheet).toBeVisible();

      await page.keyboard.press('Escape');
      await expect(sheet).toHaveCount(0);

      await page.getByRole('button', { name: 'Conectar este PC' }).click();
      await expect(sheet).toBeVisible();
      await page.mouse.click(5, 5); // no fundo, acima da folha
      await expect(sheet).toHaveCount(0);
    });
  });

  test('fora do Windows não oferece o download e explica em uma linha', async ({ page }, info) => {
    identity.loggedIn = true;
    await page.goto('/ajustes/dispositivos');
    await expect(page.getByRole('button', { name: 'Parear dispositivo' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Conectar este PC' })).toHaveCount(0);
    await expect(
      page.getByText('Para conectar um PC, abra esta tela nele (Windows).'),
    ).toBeVisible();
    await expectNoHorizontalScroll(page);
    await settle(page);
    await screenshot(page, info.outputPath('not-windows.png'));
  });

  test.describe('com o service worker ativo', () => {
    test.use({ serviceWorkers: 'allow' });

    test('o download do conector não é sequestrado pela casca do app', async ({ page }) => {
      await page.goto('/entrar');
      await waitForServiceWorkerControl(page);
      const [download] = await Promise.all([
        page.waitForEvent('download'),
        page.evaluate(() => {
          const a = document.createElement('a');
          a.href = '/conectar/conectar-uniover.cmd';
          a.download = 'conectar-uniover.cmd';
          document.body.append(a);
          a.click();
        }),
      ]);
      expect(download.suggestedFilename()).toBe('conectar-uniover.cmd');
      const text = await readFile((await download.path())!, 'utf8');
      expect(text).toContain('@echo off');
      expect(text).not.toContain('<html');
    });
  });
});
