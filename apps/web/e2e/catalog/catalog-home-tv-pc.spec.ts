import { Page } from '@playwright/test';
import { test } from '../fixtures';
import { livreView } from '../tv/livre-mock';
import { HOT_STATE } from '../tv/tv-mock';
import { READY } from '../pc/pc-mock';
import { recordGap, snap } from './catalog-kit';
import { seedTvs } from './catalog-seed';
import {
  Stack,
  TV_ONLY,
  asGuest,
  bootStack,
  feedTv,
  hold,
  open,
  waitSkeleton,
} from './catalog-setup';

// A API é simulada pelas rotas do Playwright, que não enxergam o que passa pelo service worker.
test.use({ serviceWorkers: 'block', timezoneId: 'America/Sao_Paulo', locale: 'pt-BR' });

let s: Stack;

test.beforeEach(async ({ context, page }) => {
  s = await bootStack(context, page);
});

const OFFLINE_STATE = {
  ...HOT_STATE,
  agentOnline: false,
  connection: 'disconnected',
  volume: null,
};

/** Abre o controle da TV e entrega o instantâneo da API (estado e atalhos), como o app o recebe ao abrir o fluxo. */
async function openTv(page: Page, url = '/tv', state = s.tv.state): Promise<void> {
  await page.goto(url);
  await feedTv(page, s.tv, state);
}

test('Início', async ({ page }) => {
  const M = 'Início';
  const home = { module: M, route: '/', url: '/' };
  await snap(page, { ...home, state: 'esperando a TV responder', kind: 'carregando' }, async () => {
    const release = await hold(page, '**/api/v1/tv/state');
    await page.goto('/');
    await waitSkeleton(page);
    release();
  });
  await snap(page, { ...home, state: 'dono, TV ligada e PC conectado', kind: 'com dados' }, () =>
    open(page, '/'),
  );
  await snap(
    page,
    { ...home, state: 'dono, TV ligada e PC conectado', kind: 'com dados', scheme: 'dark' },
    () => open(page, '/'),
  );
  await snap(page, { ...home, state: 'agente da TV fora do ar', kind: 'erro' }, async () => {
    s.tv.state = { ...OFFLINE_STATE };
    await open(page, '/');
  });
  s.tv.state = { ...HOT_STATE };
  await snap(page, { ...home, state: 'sem PC ligado', kind: 'vazio' }, async () => {
    s.pc.status = { available: false, online: false, apps: [] };
    await open(page, '/');
  });
  s.pc.status = { ...READY, apps: [...READY.apps] };
  await snap(page, { ...home, state: 'convidada só com o Treino', kind: 'convidado' }, async () => {
    asGuest(s.identity, ['module:training']);
    await open(page, '/');
  });
  await snap(page, { ...home, state: 'convidada só com a TV', kind: 'convidado' }, async () => {
    s.identity.guests.length = 0;
    asGuest(s.identity, TV_ONLY);
    await open(page, '/');
  });
});

test('TV: controle, painéis e estados', async ({ page }) => {
  const M = 'TV';
  const tv = { module: M, route: '/tv', url: '/tv' };
  const dot = (n: number) => page.getByRole('button', { name: `Página ${n} de 3`, exact: true });

  let release!: () => void;
  await snap(
    page,
    { ...tv, state: 'conectando (estado ainda não chegou)', kind: 'carregando' },
    async () => {
      s.tv.stateGate = new Promise<void>((resolve) => (release = resolve));
      await page.goto('/tv');
      await page.waitForTimeout(1500);
    },
  );
  release?.();
  s.tv.stateGate = null;
  await snap(page, { ...tv, state: 'ligada, página 1 (direções)', kind: 'com dados' }, () =>
    openTv(page),
  );
  await snap(
    page,
    { ...tv, state: 'ligada, página 1 (direções)', kind: 'com dados', scheme: 'dark' },
    () => openTv(page),
  );
  await snap(page, { ...tv, state: 'página 2 (números)', kind: 'com dados' }, async () => {
    await openTv(page);
    await dot(2).click();
    await page.waitForTimeout(500);
  });
  await snap(page, { ...tv, state: 'página 3 (touchpad)', kind: 'com dados' }, async () => {
    await openTv(page);
    await dot(3).click();
    await page.waitForTimeout(500);
  });
  await snap(page, { ...tv, state: 'menu (Mais opções)', kind: 'folha' }, async () => {
    await openTv(page);
    await page.getByRole('button', { name: 'Mais opções', exact: true }).click();
    await page.getByRole('dialog', { name: 'Mais opções' }).waitFor();
  });
  await snap(page, { ...tv, url: '/tv?painel=apps', state: 'painel Apps', kind: 'folha' }, () =>
    openTv(page, '/tv?painel=apps'),
  );
  await snap(
    page,
    { ...tv, url: '/tv?painel=teclado', state: 'painel Teclado', kind: 'folha' },
    () => openTv(page, '/tv?painel=teclado'),
  );
  await snap(page, { ...tv, url: '/tv?painel=botoes', state: 'painel Botões', kind: 'folha' }, () =>
    openTv(page, '/tv?painel=botoes'),
  );
  await snap(page, { ...tv, state: 'ponto de estado aberto', kind: 'folha' }, async () => {
    await openTv(page);
    await page.getByRole('button', { name: /^Estado do controle:/ }).click();
    await page.waitForTimeout(400);
  });
  await snap(page, { ...tv, state: 'confirmar desligar', kind: 'folha' }, async () => {
    await openTv(page);
    await page.getByRole('button', { name: 'Desligar a TV', exact: true }).click();
    await page.getByRole('dialog', { name: 'Desligar a TV?' }).waitFor();
  });
  await snap(page, { ...tv, state: 'erro: a TV não respondeu', kind: 'erro' }, async () => {
    await openTv(page);
    s.tv.commandFailure = { status: 504, kind: 'agent-timeout' };
    await page.getByRole('button', { name: 'OK', exact: true }).click();
    await page.getByRole('alert').waitFor();
    s.tv.commandFailure = null;
  });
  await snap(page, { ...tv, state: 'agente do PC fora do ar', kind: 'erro' }, () =>
    openTv(page, '/tv', OFFLINE_STATE),
  );
  await snap(page, { ...tv, state: 'nenhuma TV configurada', kind: 'vazio' }, async () => {
    s.tv.wakeFailure = { status: 503, kind: 'agent-not-configured' };
    await openTv(page, '/tv', OFFLINE_STATE);
    s.tv.wakeFailure = null;
  });
  await snap(page, { ...tv, state: 'sem atalhos de apps', kind: 'vazio' }, async () => {
    const keep = s.tv.shortcuts;
    s.tv.shortcuts = [];
    await openTv(page);
    s.tv.shortcuts = keep;
  });
  await snap(
    page,
    { ...tv, state: 'duas TVs (seletor no título)', kind: 'com dados' },
    async () => {
      s.tv.tvs = seedTvs();
      await openTv(page);
      s.tv.tvs = null;
    },
  );
  await snap(page, { ...tv, state: 'convidada só com o controle', kind: 'convidado' }, async () => {
    asGuest(s.identity, TV_ONLY);
    await openTv(page);
  });
  recordGap(
    M,
    '/tv',
    'TV Samsung pedindo "Permitir"',
    'Só aparece trocando a TV pela interface; o catálogo não conduz esse fluxo.',
  );
  recordGap(M, '/tv', 'atalhos com ícone real', 'O simulador entrega atalhos sem ícone.');
});

test('TV: configurar e TV Livre', async ({ page }) => {
  const M = 'TV';
  const setup = { module: M, route: '/tv/configurar', url: '/tv/configurar' };
  await snap(page, { ...setup, state: 'guia de configuração', kind: 'padrão' }, () =>
    open(page, '/tv/configurar'),
  );
  const livre = { module: M, route: '/tv/livre', url: '/tv/livre' };
  await snap(page, { ...livre, state: 'esperando o agente', kind: 'carregando' }, async () => {
    const release = await hold(page, '**/api/v1/tv/livre**');
    await page.goto('/tv/livre');
    await waitSkeleton(page);
    release();
  });
  await snap(page, { ...livre, state: 'ainda não instalado', kind: 'vazio' }, () =>
    open(page, '/tv/livre'),
  );
  await snap(
    page,
    { ...livre, state: 'instalado e como tela inicial', kind: 'com dados' },
    async () => {
      s.livre.view = livreView({ installed: true, isHome: true, version: '0.2.0' });
      await open(page, '/tv/livre');
    },
  );
  await snap(page, { ...livre, state: 'TV sem suporte', kind: 'erro' }, async () => {
    s.livre.view = livreView({ supported: false });
    await open(page, '/tv/livre');
  });
});

test('PC', async ({ page }) => {
  const M = 'PC';
  const tabs: [string, string][] = [
    ['/pc', 'touchpad'],
    ['/pc/teclado', 'teclado'],
    ['/pc/midia', 'mídia'],
    ['/pc/energia', 'energia'],
  ];
  for (const [route, name] of tabs) {
    await snap(
      page,
      { module: M, route, url: route, state: `${name}, PC conectado`, kind: 'com dados' },
      () => open(page, route),
    );
  }
  const pc = { module: M, route: '/pc', url: '/pc' };
  await snap(
    page,
    { ...pc, state: 'touchpad, PC conectado', kind: 'com dados', scheme: 'dark' },
    () => open(page, '/pc'),
  );
  await snap(page, { ...pc, state: 'PC desligado ou sem agente', kind: 'erro' }, async () => {
    s.pc.status = { available: true, online: false, apps: [] };
    await open(page, '/pc');
  });
  await snap(page, { ...pc, state: 'PC ainda não disponível', kind: 'vazio' }, async () => {
    s.pc.status = { available: false, online: false, apps: [] };
    await open(page, '/pc');
  });
  s.pc.status = { ...READY, apps: [...READY.apps] };
  await snap(
    page,
    {
      module: M,
      route: '/pc/energia',
      url: '/pc/energia',
      state: 'confirmar suspender',
      kind: 'folha',
    },
    async () => {
      await open(page, '/pc/energia');
      await page
        .getByRole('button', { name: /Suspender/ })
        .first()
        .click();
      await page.waitForTimeout(500);
    },
  );
});
