import { BrowserContext, Page } from '@playwright/test';
import { afterFrames, settle } from '../screens/screen-helpers';
import { GUEST, IdentityMock, TV_CONTROL_ONLY, mockIdentityApi } from '../auth/identity-mock';
import { DevicesMock, mockDevicesApi } from '../devices/devices-mock';
import { PcMock, mockPcApi } from '../pc/pc-mock';
import { AuditMock, mockAuditApi } from '../settings/audit-mock';
import { SiriMock, mockSiriApi } from '../settings/siri-mock';
import { SystemMock, mockSystemApi } from '../system/system-mock';
import { HOT_STATE, TvMock, emitSse, installFakeEventSource, mockTvApi } from '../tv/tv-mock';
import { LivreMock, mockLivreApi } from '../tv/livre-mock';

/** Todos os simuladores de API do e2e numa conta só, registrados na mesma ordem que os testes de cada módulo usam. */
export interface Stack {
  identity: IdentityMock;
  tv: TvMock;
  livre: LivreMock;
  siri: SiriMock;
  system: SystemMock;
  devices: DevicesMock;
  audit: AuditMock;
  pc: PcMock;
}

/**
 * Sobe a identidade, a TV, o TV Livre, as chaves dos Atalhos, o Sistema, os Dispositivos, a Auditoria e o PC. A rota
 * registrada por último vence, e os módulos da TV dividem o prefixo `/api/v1/tv/`: por isso a TV vem antes dos que a
 * refinam (Livre, Atalhos e Sistema), como nos testes de cada um.
 */
export async function bootStack(
  context: BrowserContext,
  page: Page,
  options: { loggedIn?: boolean } = {},
): Promise<Stack> {
  // O WebKit do Playwright não traz WebAuthn; sem ele a Segurança esconderia o botão de cadastrar passkey.
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
  const identity = await mockIdentityApi(context);
  identity.loggedIn = options.loggedIn ?? true;
  const tv = await mockTvApi(context, identity);
  const livre = await mockLivreApi(context, identity);
  const siri = await mockSiriApi(context, identity);
  const system = await mockSystemApi(context, identity);
  const devices = await mockDevicesApi(context, identity);
  const audit = await mockAuditApi(context, identity);
  const pc = await mockPcApi(context, identity);
  await installFakeEventSource(page);
  return { identity, tv, livre, siri, system, devices, audit, pc };
}

/** A convidada com a sessão aberta e as permissões dadas (o papel decide o que `/me` devolve e o que a API recusa). */
export function asGuest(identity: IdentityMock, permissions: readonly string[]): void {
  identity.guests.push({
    id: '00000000-0000-4000-8000-000000000051',
    displayName: GUEST.displayName,
    email: GUEST.email,
    password: GUEST.password,
    createdAt: '2026-10-19T15:00:00Z',
    disabledAt: null,
    permissions: [...permissions],
  });
  identity.role = 'guest';
}

export const TV_ONLY: readonly string[] = TV_CONTROL_ONLY;

/**
 * Espera a tela parar de mexer: dois quadros para o que o último evento pediu ser desenhado, e então as animações finitas
 * (as entradas escalonadas, inclusive as que ainda estão no atraso) terminarem. Por condição: sob carga espera mais.
 */
export async function still(page: Page): Promise<void> {
  await afterFrames(page);
  await settle(page);
  await afterFrames(page);
}

/**
 * Espera a tela sair de qualquer espera: o esqueleto da abertura some, nenhuma região ocupada sobra e as entradas
 * escalonadas terminam. Para estados de "carregando" não se usa: a captura é justamente a espera.
 */
export async function calm(page: Page): Promise<void> {
  await page.waitForLoadState('load');
  await page
    .waitForFunction(
      () => !document.querySelector('#boot-skeleton, app-update-skeleton .bs-root'),
      null,
      {
        timeout: 20_000,
      },
    )
    .catch(() => undefined);
  await page
    .waitForFunction(() => !document.querySelector('app-loading-frame[aria-busy="true"]'), null, {
      timeout: 20_000,
    })
    .catch(() => undefined);
  await still(page);
}

/** Abre o endereço e espera a tela sossegar. */
export async function open(page: Page, url: string): Promise<void> {
  await page.goto(url);
  await calm(page);
}

/** Entrega à TV aberta o instantâneo que a API manda ao abrir o fluxo (estado e atalhos), como o app o recebe. */
export async function feedTv(page: Page, tv: TvMock, state = tv.state): Promise<void> {
  await page
    .waitForFunction(
      () => (window as unknown as { __sse?: { urls(): string[] } }).__sse?.urls().length,
      null,
      { timeout: 10_000 },
    )
    .catch(() => undefined);
  await emitSse(page, 'tv.state', state);
  await emitSse(page, 'tv.shortcuts', tv.shortcuts);
  await still(page);
}

export { HOT_STATE };

/**
 * Segura as respostas de uma rota até `release()`: a tela fica na espera para o catálogo ver o esqueleto. A rota da página
 * vence a do contexto (o simulador); `fallback` devolve o pedido a ele depois, com o dado de sempre.
 */
export async function hold(page: Page, pattern: string): Promise<() => void> {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  await page.route(pattern, async (route) => {
    await gate;
    await route.fallback();
  });
  return release;
}

/** Espera o esqueleto aparecer de verdade: ele só se mostra depois de uma fração de segundo (espera curta não pisca). */
export async function waitSkeleton(page: Page): Promise<void> {
  await page
    .waitForFunction(
      () =>
        Array.from(
          document.querySelectorAll<HTMLElement>('.ui-skeleton, #boot-skeleton .bone'),
        ).some(
          (bone) =>
            Number(getComputedStyle(bone).opacity) > 0.5 && bone.getBoundingClientRect().height > 0,
        ),
      null,
      { timeout: 8000 },
    )
    .catch(() => undefined);
  await still(page);
}
