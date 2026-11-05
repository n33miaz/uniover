import { test } from '../fixtures';
import { recordGap, snap } from './catalog-kit';
import { Stack, asGuest, bootStack, calm, open } from './catalog-setup';
import { seedSettings } from './catalog-seed';

/**
 * Catálogo de telas: visita cada rota com a API simulada do e2e e guarda uma captura por estado. Nada aqui afirma
 * comportamento; o que não abre vira linha de falha no quadro de cobertura. Rodar com `npm run catalog`.
 */

// A API é simulada pelas rotas do Playwright, que não enxergam o que passa pelo service worker.
test.use({ serviceWorkers: 'block', timezoneId: 'America/Sao_Paulo', locale: 'pt-BR' });

test.describe('Ajustes', () => {
  const M = 'Ajustes';
  let s: Stack;

  test.beforeEach(async ({ context, page }) => {
    s = await bootStack(context, page);
  });

  test('o dono: lista e telas filhas, vazias e com dados', async ({ page }) => {
    const screens: { route: string; url?: string; state?: string }[] = [
      { route: '/ajustes' },
      { route: '/ajustes/perfil' },
      { route: '/ajustes/aparencia' },
      { route: '/ajustes/seguranca' },
      { route: '/ajustes/seguranca/siri' },
      { route: '/ajustes/pessoas' },
      { route: '/ajustes/tvs-por-pessoa' },
      { route: '/ajustes/auditoria' },
      { route: '/ajustes/sistema' },
      { route: '/ajustes/dispositivos' },
      { route: '/ajustes/sobre' },
      { route: '/ajustes/sobre/creditos' },
    ];
    // Primeiro tudo vazio (conta nova), depois a mesma rota com dados.
    for (const item of screens) {
      const url = item.url ?? item.route;
      await snap(
        page,
        { module: M, route: item.route, url, state: 'conta nova (vazio)', kind: 'vazio' },
        () => open(page, url),
      );
    }
    seedSettings(s);
    for (const item of screens) {
      const url = item.url ?? item.route;
      await snap(
        page,
        { module: M, route: item.route, url, state: 'com dados', kind: 'com dados' },
        () => open(page, url),
      );
    }
    await snap(
      page,
      {
        module: M,
        route: '/ajustes/tv/:id/historico',
        url: `/ajustes/tv/11111111-1111-4111-8111-111111111111/historico`,
        state: 'com histórico',
        kind: 'com dados',
      },
      () => open(page, '/ajustes/tv/11111111-1111-4111-8111-111111111111/historico'),
    );
    for (const route of ['/ajustes', '/ajustes/aparencia', '/ajustes/sistema']) {
      await snap(
        page,
        { module: M, route, url: route, state: 'com dados', kind: 'com dados', scheme: 'dark' },
        () => open(page, route),
      );
    }
    recordGap(
      M,
      '/ajustes/seguranca',
      'passkeys reais',
      'O WebKit do teste não tem WebAuthn: o cadastro de passkey não roda.',
    );
  });

  test('a convidada: o que ela vê em Ajustes', async ({ page }) => {
    seedSettings(s);
    asGuest(s.identity, ['module:tv', 'tv:control', 'tv:power', 'tv:launch', 'tv:history']);
    for (const route of [
      '/ajustes',
      '/ajustes/perfil',
      '/ajustes/seguranca',
      '/ajustes/dispositivos',
      '/ajustes/sobre',
    ]) {
      await snap(
        page,
        { module: M, route, url: route, state: 'conta convidada', kind: 'convidado' },
        () => open(page, route),
      );
    }
  });
});
