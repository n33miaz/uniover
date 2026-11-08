import { Page } from '@playwright/test';
import { expect, screenshot, test } from '../fixtures';
import { mockIdentityApi } from '../auth/identity-mock';
import { installFakeEventSource, mockTvApi } from '../tv/tv-mock';
import { mockTrainingApi } from '../training/support/training-server';
import { seedTraining } from '../training/support/training-seed';
import { settle } from './screen-helpers';

// A API é simulada pelas rotas do Playwright, que não enxergam o que passa pelo service worker.
test.use({ serviceWorkers: 'block', timezoneId: 'America/Sao_Paulo' });

/** O respiro mínimo entre o fim do topo e o que vem logo abaixo. */
const MIN_GAP_PX = 12;
const MAX_GAP_PX = 22; // 16 nas telas do Treino, 20 em Configurações (as telas dali abrem com 16 px de margem própria)
const PRINTS = process.env['TOP_BAR_PRINTS_DIR'];

test.beforeEach(async ({ context, page }) => {
  const identity = await mockIdentityApi(context);
  identity.loggedIn = true;
  const training = await mockTrainingApi(context);
  seedTraining(training, {});
  await mockTvApi(context, identity);
  await installFakeEventSource(page);
});

/** Quantos pixels separam a base dos controles do topo da primeira caixa visível do conteúdo (ou do que a precede) abaixo dele. */
async function gapBelowTopBar(page: Page): Promise<{ gap: number; who: string }> {
  return page.evaluate(() => {
    const bar = document.querySelector('app-page-top-bar')!;
    // A base do que se vê no topo (o círculo, o título), não a da caixa da barra, que carrega a própria folga de baixo.
    const barBottom = Math.max(
      ...Array.from(bar.querySelectorAll('button, a, h1')).map(
        (el) => el.getBoundingClientRect().bottom,
      ),
    );
    const root = bar.parentElement!;
    // Primeiro elemento com caixa visível, depois do topo, no fluxo da casca (a linha de sincronização some quando está ok).
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    let top = Infinity;
    let who = '';
    for (
      let node = walker.nextNode() as HTMLElement | null;
      node;
      node = walker.nextNode() as HTMLElement | null
    ) {
      if (bar.contains(node) || node.contains(bar)) continue;
      const box = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      // Fora do fluxo (texto só para leitor de tela, posicionado por cima) não é o que a pessoa vê abaixo do topo.
      if (box.height < 2 || box.width < 2 || style.visibility === 'hidden') continue;
      if (style.position === 'absolute' || style.position === 'fixed') continue;
      if (node.closest('[aria-hidden="true"]') && !node.closest('.skeleton-home')) continue;
      if (box.top < barBottom - 0.5) continue;
      // Só o que desenha algo: texto próprio, fundo ou borda (contêineres vazios não contam).
      const ownText = Array.from(node.childNodes).some(
        (child) => child.nodeType === Node.TEXT_NODE && child.textContent?.trim(),
      );
      const paints =
        ownText ||
        style.backgroundColor !== 'rgba(0, 0, 0, 0)' ||
        parseFloat(style.borderTopWidth) > 0 ||
        node.tagName === 'SVG';
      if (!paints) continue;
      if (box.top < top) {
        top = box.top;
        who = `${node.tagName.toLowerCase()}.${node.className}`;
      }
    }
    return { gap: top - barBottom, who };
  });
}

async function shot(page: Page, name: string, info: { project: { name: string } }) {
  if (!PRINTS) return;
  await settle(page);
  await screenshot(page, `${PRINTS}/${name}-${info.project.name}.png`);
}

test.describe('Topo das páginas dos módulos', () => {
  for (const [name, path, title, ready] of [
    ['treino-hoje', '/treino', 'Treino', '.home .routine:not(.skeleton)'],
    ['treino-exercicios', '/treino/exercicios', 'Treino', '.list .ui-row'],
    ['treino-rotinas', '/treino/rotinas', 'Treino', ''],
    ['treino-glossario', '/treino/glossario', 'Treino', ''],
    ['treino-progresso', '/treino/progresso', 'Treino', ''],
    ['treino-corpo', '/treino/corpo', 'Treino', ''],
    ['treino-refeicoes', '/treino/alimentacao', 'Treino', ''],
    ['configuracoes', '/ajustes', 'Configurações', ''],
    ['configuracoes-aparencia', '/ajustes/aparencia', 'Aparência', ''],
  ] as const) {
    test(`${name}: o conteúdo não fica colado ao topo`, async ({ page }, info) => {
      await page.emulateMedia({ colorScheme: 'light' });
      await page.goto(path);
      await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();
      // A casca do Treino mostra "Confirmando a sua conta…" até a conta valer; o que importa é a tela já aberta.
      await expect(page.locator('app-training-account-scope .ui-notice')).toHaveCount(0);
      // Cada tela do módulo espera o dado dentro da moldura de carregamento e a tira quando ele chega: medir antes é medir o esqueleto.
      await expect(page.locator('app-loading-frame')).toHaveCount(0);
      if (ready) await expect(page.locator(ready).first()).toBeVisible();
      await settle(page);
      const { gap, who } = await gapBelowTopBar(page);
      expect(gap, `primeiro conteúdo: ${who}`).toBeGreaterThanOrEqual(MIN_GAP_PX);
      expect(gap, `primeiro conteúdo: ${who}`).toBeLessThanOrEqual(MAX_GAP_PX);
      await shot(page, name, info);
    });
  }
});

/**
 * O título do topo cabe numa linha, inteiro: sem quebra, sem reticências e sem passar do espaço entre os dois círculos. Mede o
 * texto pelo `Range` (a caixa do h1 esconde o excesso) e confere a altura de uma linha só.
 */
async function titleFit(page: Page) {
  // Consulta o documento na hora (e não um elemento já resolvido): a casca do Treino troca o topo ao confirmar a conta.
  return page.evaluate(() => {
    const h1 = document.querySelector('app-page-top-bar h1')!;
    const style = getComputedStyle(h1);
    const range = document.createRange();
    range.selectNodeContents(h1);
    const text = range.getBoundingClientRect();
    const box = h1.getBoundingClientRect();
    const bar = h1.closest('app-page-top-bar')!;
    const circles = Array.from(bar.querySelectorAll('button, a')).map((el) =>
      el.getBoundingClientRect(),
    );
    return {
      fontSize: parseFloat(style.fontSize),
      lines: range.getClientRects().length,
      clipped: h1.scrollWidth - h1.clientWidth,
      textWidth: text.width,
      boxWidth: box.width,
      left: text.left,
      right: text.right,
      circleLeft: Math.max(
        0,
        ...circles.filter((c) => c.right <= box.left + 1).map((c) => c.right),
      ),
      circleRight: Math.min(
        document.documentElement.clientWidth,
        ...circles.filter((c) => c.left >= box.right - 1).map((c) => c.left),
      ),
    };
  });
}

test.describe('Título do topo: uma linha, sem corte', () => {
  for (const width of [360, 390]) {
    for (const [path, title] of [
      ['/treino', 'Treino'],
      ['/ajustes', 'Configurações'],
      ['/ajustes/aparencia', 'Aparência'],
      ['/ajustes/pessoas', 'Pessoas e Permissões'],
      ['/ajustes/seguranca/siri', 'Atalhos da Siri'],
      ['/ajustes/tvs-por-pessoa', 'TVs por Pessoa'],
    ] as const) {
      test(`${title} em ${width} px cabe inteiro numa linha`, async ({ page }) => {
        await page.setViewportSize({ width, height: 800 });
        await page.emulateMedia({ colorScheme: 'light' });
        await page.goto(path);
        await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();
        // A casca do Treino troca o topo quando a conta passa a valer: mede só depois, com um único topo na tela.
        await expect(page.locator('app-training-account-scope .ui-notice')).toHaveCount(0);
        await expect(page.locator('app-page-top-bar')).toHaveCount(1);
        await settle(page);
        const fit = await titleFit(page);
        // Uma linha só, nada escondido pelas reticências e dentro do espaço entre os círculos.
        expect(fit.lines, `linhas de "${title}"`).toBe(1);
        expect(fit.clipped, `corte de "${title}" (${fit.fontSize}px)`).toBeLessThanOrEqual(0);
        expect(fit.left).toBeGreaterThanOrEqual(fit.circleLeft - 0.5);
        expect(fit.right).toBeLessThanOrEqual(fit.circleRight + 0.5);
        // Letra legível: o título encolhe, mas não some.
        expect(fit.fontSize).toBeGreaterThanOrEqual(14);
        expect(fit.fontSize).toBeLessThanOrEqual(21.7);
      });
    }
  }

  test('um título longo demais encolhe até caber, em vez de ganhar reticências', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 800 });
    await page.goto('/ajustes/aparencia');
    await expect(page.getByRole('heading', { level: 1, name: 'Aparência' })).toBeVisible();
    // Texto sintético mais longo que qualquer título real: o tamanho acompanha o comprimento.
    await page.locator('app-page-top-bar h1').evaluate((h1) => {
      h1.textContent = 'Pessoas e Permissões da Casa';
      (h1 as HTMLElement).style.setProperty('--title-len', String(h1.textContent.length));
    });
    const long = await titleFit(page);
    expect(long.clipped).toBeLessThanOrEqual(0);
    expect(long.lines).toBe(1);
    expect(long.fontSize).toBeLessThan(21.6);
  });
});

test.describe('Início: a marca no centro da tela', () => {
  for (const width of [390, 430]) {
    test(`em ${width} px o texto fica no centro real`, async ({ page }, info) => {
      await page.setViewportSize({ width, height: 800 });
      await page.emulateMedia({ colorScheme: 'light' });
      await page.goto('/');
      await expect(page.locator('.home-topbar .brand')).toBeVisible();
      await settle(page);
      const center = await page.locator('.home-topbar .brand').evaluate((brand) => {
        const range = document.createRange();
        range.selectNodeContents(brand);
        const text = range.getBoundingClientRect();
        // O espaçamento entre letras também fica depois da última: o desenho do texto termina meio espaço antes.
        const spacing = parseFloat(getComputedStyle(brand).letterSpacing) || 0;
        return {
          ink: text.left + text.width / 2 - spacing / 2,
          viewport: document.documentElement.clientWidth,
        };
      });
      expect(Math.abs(center.ink - center.viewport / 2)).toBeLessThanOrEqual(1.5);
      if (width === 390) await shot(page, 'inicio', info);
    });
  }
});
