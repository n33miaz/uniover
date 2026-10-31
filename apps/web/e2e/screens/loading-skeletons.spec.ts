import { BrowserContext, Page } from '@playwright/test';
import { IdentityMock, mockIdentityApi } from '../auth/identity-mock';
import { mockDevicesApi } from '../devices/devices-mock';
import { expect, expectNoHorizontalScroll, test } from '../fixtures';
import { mockAuditApi } from '../settings/audit-mock';
import { mockSystemApi } from '../system/system-mock';
import { SEED_EXERCISE_IDS, SEED_ROUTINE_IDS } from '../training/support/training-seed';
import { mockTrainingApi } from '../training/support/training-server';
import { seedTraining } from '../training/support/training-seed';
import { installFakeEventSource, mockTvApi } from '../tv/tv-mock';
import { expectNoA11yViolations, settle } from './screen-helpers';

// A API é simulada pelas rotas do Playwright, que não enxergam o que passa pelo service worker.
test.use({ serviceWorkers: 'block' });

/** A região ocupada que toda espera do app leva: anunciada uma vez só, com o texto que o leitor de tela ouve. */
const BUSY = 'app-loading-frame[aria-busy="true"]';

let identity: IdentityMock;

test.beforeEach(async ({ context, page }) => {
  identity = await mockIdentityApi(context);
  identity.loggedIn = true;
  await installFakeEventSource(page);
});

/**
 * Segura as respostas da fonte de dados até o teste soltar. A rota da página vence a do contexto (o simulador), e
 * `fallback` devolve o pedido a ele depois da espera: o dado que chega é o mesmo de sempre, só atrasado.
 */
async function hold(page: Page, pattern: string) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  await page.route(pattern, async (route) => {
    await gate;
    await route.fallback();
  });
  return release;
}

/**
 * Vigia a tela quadro a quadro, desde o primeiro: guarda (1) cada quadro em que a área da tela (`main`) fica sem nada que
 * ocupe lugar, o buraco que um esqueleto no lugar errado deixa entre uma espera e a seguinte, (2) se alguma forma de espera
 * chegou a ficar visível de verdade (depois do atraso, não só reservada) e (3) quanto a tela pulou (só o Chromium mede).
 * O esqueleto só se mostra depois de ~200 ms, então o que se mede é o espaço reservado, nunca a visibilidade.
 */
async function watchScreen(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as {
      __gaps: number[];
      __seen: boolean;
      __shift: number;
      __frames: number;
      __shifts: string[];
    };
    w.__shifts = [];
    w.__frames = 0;
    w.__gaps = [];
    w.__seen = false;
    w.__shift = 0;
    const MIN_USED = 100;
    let armed = false;
    const tick = () => {
      w.__frames += 1;
      const main = document.querySelector('main');
      if (main) {
        const top = main.getBoundingClientRect().top;
        let bottom = top;
        for (const element of Array.from(main.querySelectorAll('*'))) {
          const box = element.getBoundingClientRect();
          if (box.width > 0 && box.height > 0) bottom = Math.max(bottom, box.bottom);
        }
        const used = bottom - top;
        if (used >= MIN_USED) armed = true;
        else if (armed) w.__gaps.push(Math.round(used));
      }
      if (!w.__seen) {
        for (const bone of Array.from(document.querySelectorAll<HTMLElement>('.ui-skeleton'))) {
          const wrapper = bone.closest<HTMLElement>('.ui-wait');
          const visible =
            Number(getComputedStyle(bone).opacity) > 0.5 &&
            (!wrapper || Number(getComputedStyle(wrapper).opacity) > 0.99);
          if (visible && bone.getBoundingClientRect().height > 0) w.__seen = true;
        }
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries() as unknown as {
          value: number;
          hadRecentInput: boolean;
          sources?: { node?: Element | null }[];
        }[]) {
          if (entry.hadRecentInput) continue;
          w.__shift += entry.value;
          // Quem pulou, para a falha dizer onde a forma do esqueleto não casou com a tela de verdade.
          const who = (entry.sources ?? [])
            .map((source) => source.node)
            .filter((node): node is Element => !!node)
            .map((node) => `${node.tagName.toLowerCase()}.${String(node.className).split(' ')[0]}`);
          w.__shifts.push(`${entry.value.toFixed(3)} ${who.join(', ')}`);
        }
      }).observe({ type: 'layout-shift', buffered: true });
    } catch {
      // O WebKit não expõe os saltos de layout: lá a medida do pulo fica de fora.
    }
  });
}

async function watched(page: Page) {
  return page.evaluate(() => {
    const w = window as unknown as {
      __gaps: number[];
      __seen: boolean;
      __shift: number;
      __frames: number;
      __shifts: string[];
    };
    return {
      gaps: w.__gaps,
      seen: w.__seen,
      shift: w.__shift,
      frames: w.__frames,
      shifts: w.__shifts,
    };
  });
}

interface Screen {
  /** O endereço aberto. */
  readonly path: string;
  /** Só as respostas deste endereço são seguradas. */
  readonly hold: string;
  /** O que a tela mostra quando o dado chega (sem o dado, é o estado vazio dela). */
  readonly done: (page: Page) => ReturnType<Page['locator']>;
  /** Prepara os simuladores que a tela usa além da identidade. */
  readonly setup?: (context: BrowserContext) => Promise<void>;
  /**
   * Quanto a tela pode pular (só medido no Chromium). A forma do esqueleto é a de uma lista média; onde a quantidade real
   * de itens depende do dado (as TVs e a saúde do sistema, no simulador), a diferença de altura é esperada.
   */
  readonly maxShift?: number;
}

const SETTINGS_SCREENS: readonly Screen[] = [
  {
    path: '/ajustes/seguranca',
    hold: '**/api/v1/identity/passkeys',
    done: (page) => page.getByText('Nenhuma passkey cadastrada.'),
  },
  {
    path: '/ajustes/pessoas',
    hold: '**/api/v1/identity/guests',
    done: (page) => page.getByText('Ninguém foi convidado ainda.'),
  },
  {
    path: '/ajustes/auditoria',
    hold: '**/api/v1/identity/audit**',
    done: (page) => page.getByText('Ainda não há registros.'),
    setup: async (context) => void (await mockAuditApi(context, identity)),
  },
  {
    path: '/ajustes/sistema',
    hold: '**/api/v1/tv/**',
    done: (page) => page.getByRole('heading', { level: 2, name: 'Saúde' }),
    maxShift: 0.2,
    setup: async (context) => {
      await mockTvApi(context, identity);
      await mockSystemApi(context, identity);
    },
  },
  {
    path: '/ajustes/dispositivos',
    hold: '**/api/v1/devices/agents',
    done: (page) => page.getByText(/Nenhum (aparelho|dispositivo) pareado\./),
    setup: async (context) => void (await mockDevicesApi(context, identity)),
  },
  {
    path: '/entrar/qr?codigo=Qr1aaaaaaaaaaaaa',
    hold: '**/api/v1/identity/auth/qr/info',
    done: (page) => page.getByRole('button', { name: 'Confirmar' }),
    setup: async () => {
      identity.qr.requests.push({
        code: 'Qr1aaaaaaaaaaaaa',
        secret: 'segredo-do-pc',
        userAgent:
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
        status: 'pending',
      });
    },
  },
];

/** As caixas do esqueleto que estão na tela agora: tamanho, animação e a região ocupada que as contém. */
async function bones(page: Page) {
  return page.evaluate((busy) => {
    return Array.from(document.querySelectorAll<HTMLElement>(`${busy} .ui-skeleton`)).map(
      (bone) => {
        const box = bone.getBoundingClientRect();
        return {
          width: box.width,
          height: box.height,
          animation: getComputedStyle(bone).animationName,
        };
      },
    );
  }, BUSY);
}

/** Depois que o dado chegou: nenhuma forma de espera (nem outra) fica para trás em laço. */
async function expectNoWaitLeft(page: Page) {
  await expect(page.locator('app-loading-frame')).toHaveCount(0);
  await expect(page.locator('.ui-skeleton')).toHaveCount(0);
}

test.describe('esqueleto de espera: Configurações, Dispositivos e entrada por QR', () => {
  for (const screen of SETTINGS_SCREENS) {
    test(`${screen.path}: forma da tela enquanto o dado demora, nunca vazia, e nenhuma espera depois`, async ({
      context,
      page,
    }, info) => {
      await screen.setup?.(context);
      await watchScreen(page);
      const release = await hold(page, screen.hold);
      try {
        await page.goto(screen.path);

        // A região ocupada aparece (reservada desde o primeiro quadro), tem altura de verdade e é anunciada uma vez só.
        const busy = page.locator(BUSY).first();
        await expect(busy).toBeAttached();
        // Só se mostra depois de uma fração de segundo (espera curta não pisca): espera o atraso acabar.
        await expect.poll(async () => (await watched(page)).seen).toBe(true);
        await settle(page);
        const box = await busy.boundingBox();
        expect(box?.height ?? 0).toBeGreaterThan(40);

        const found = await bones(page);
        expect(found.length).toBeGreaterThan(1);
        for (const bone of found) {
          expect(bone.width).toBeGreaterThan(0);
          expect(bone.height).toBeGreaterThan(0);
          // O brilho único do app (ou a pulsação, com movimento reduzido): nunca uma forma parada.
          expect(bone.animation).toMatch(/ui-shimmer|ui-pulse/);
        }
        await expectNoHorizontalScroll(page);
        await expectNoA11yViolations(page);
      } finally {
        release();
      }

      // O dado chegou: a tela de verdade entra no lugar do esqueleto, sem buraco nem pulo.
      await expect(screen.done(page)).toBeVisible();
      await expectNoWaitLeft(page);
      const result = await watched(page);
      // O vigia rodou de verdade durante a espera (quadros contados) e nunca viu a área vazia.
      expect(result.frames).toBeGreaterThan(20);
      expect(result.gaps).toEqual([]);
      if (info.project.name === 's23-fe')
        expect(result.shift, `saltos: ${result.shifts.join(' | ')}`).toBeLessThan(
          screen.maxShift ?? 0.1,
        );
    });
  }

  test('com movimento reduzido o esqueleto pulsa em vez de correr', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const release = await hold(page, '**/api/v1/identity/passkeys');
    try {
      await page.goto('/ajustes/seguranca');
      await expect(page.locator(BUSY).first()).toBeAttached();
      await settle(page);
      const found = await bones(page);
      expect(found.length).toBeGreaterThan(1);
      for (const bone of found) expect(bone.animation).toMatch(/ui-pulse/);
    } finally {
      release();
    }
    await expect(page.locator(BUSY)).toHaveCount(0);
  });

  test('uma espera que não acaba vira um aviso curto com "Tentar de Novo", e a leitura é refeita', async ({
    page,
  }) => {
    // O relógio é o do Playwright: o teto de 20 s passa sem esperar de verdade.
    await page.clock.install({ time: new Date() });
    let requests = 0;
    await page.route('**/api/v1/identity/passkeys', async (route) => {
      requests += 1;
      // A primeira leitura nunca responde; a segunda (depois de "Tentar de Novo") volta ao simulador.
      if (requests === 1) return;
      await route.fallback();
    });
    await page.goto('/ajustes/seguranca');
    await expect(page.locator(BUSY).first()).toBeAttached();

    await page.clock.fastForward(25_000);
    const alert = page
      .getByRole('alert')
      .filter({ hasText: 'Está demorando mais do que o normal.' });
    await expect(alert).toBeVisible();
    await expect(page.locator(BUSY)).toHaveCount(0);

    await alert.getByRole('button', { name: 'Tentar de Novo' }).click();
    await expect(page.getByText('Nenhuma passkey cadastrada.')).toBeVisible();
    await expectNoWaitLeft(page);
    expect(requests).toBeGreaterThanOrEqual(2);
  });
});

/**
 * O banco local do Treino abre devagar: o `success` do pedido de abertura (e só ele, os demais ficam dentro de transações
 * que não esperam) chega depois de `delay` ms. É o que uma conta grande num aparelho cansado faz.
 */
async function slowTrainingDb(page: Page, delay: number) {
  await page.addInitScript((ms) => {
    const original = Object.getOwnPropertyDescriptor(IDBRequest.prototype, 'onsuccess');
    if (!original?.set) return;
    Object.defineProperty(IDBRequest.prototype, 'onsuccess', {
      configurable: true,
      get: original.get,
      set(handler: ((event: Event) => unknown) | null) {
        if (typeof handler === 'function' && this instanceof IDBOpenDBRequest) {
          const delayed = function (this: IDBRequest, event: Event) {
            setTimeout(() => handler.call(this, event), ms);
          };
          original.set!.call(this, delayed);
        } else {
          original.set!.call(this, handler);
        }
      },
    });
  }, delay);
}

interface TrainingScreen {
  readonly name: string;
  readonly path: string;
  /** Como em `Screen.maxShift`. */
  readonly maxShift?: number;
  readonly done: (page: Page) => ReturnType<Page['locator']>;
}

const TRAINING_SCREENS: readonly TrainingScreen[] = [
  {
    name: 'Hoje',
    path: '/treino',
    // A faixa dos programas sugeridos espera a lista de modelos do servidor e some quando ele não tem nenhum (o simulador não tem).
    maxShift: 0.2,
    done: (page) => page.getByRole('heading', { name: 'Esta Semana', exact: true }),
  },
  {
    name: 'exercícios',
    path: '/treino/exercicios',
    done: (page) => page.locator('.list .ui-row').first(),
  },
  {
    name: 'rotinas',
    path: '/treino/rotinas',
    done: (page) => page.locator('.next-card'),
  },
  {
    name: 'ficha do exercício',
    path: `/treino/exercicios/${SEED_EXERCISE_IDS.plank}`,
    done: (page) => page.getByRole('heading', { name: 'Prancha isométrica' }),
  },
  {
    name: 'editor de rotina',
    path: `/treino/rotinas/${SEED_ROUTINE_IDS.a}`,
    done: (page) => page.getByRole('button', { name: /Supino reto com barra/ }).first(),
  },
  {
    name: 'progresso',
    path: '/treino/progresso',
    done: (page) => page.locator('app-training-page main, app-training-page').first(),
  },
  {
    name: 'corpo',
    path: '/treino/corpo',
    done: (page) => page.locator('.page').first(),
  },
  {
    name: 'alimentação',
    path: '/treino/alimentacao',
    // A lista do dia é de um tamanho só quando há lançamentos; o simulador começa com o diário vazio (só o recado).
    maxShift: 0.2,
    done: (page) => page.locator('app-training-page').first(),
  },
];

test.describe('esqueleto de espera: Treino', () => {
  for (const screen of TRAINING_SCREENS) {
    test(`${screen.name}: com o banco local lento a tela nunca fica vazia e a espera some`, async ({
      context,
      page,
    }, info) => {
      const server = await mockTrainingApi(context);
      seedTraining(server, {});

      await watchScreen(page);
      await slowTrainingDb(page, 1500);
      await page.goto(screen.path);

      // Enquanto o banco abre, a casca do módulo já mostra a forma da tela (e não só um texto).
      await expect.poll(async () => (await watched(page)).seen, { timeout: 5000 }).toBe(true);
      await expect(page.locator(BUSY).first()).toBeAttached();
      await expectNoHorizontalScroll(page);

      await expect(screen.done(page)).toBeVisible({ timeout: 25_000 });
      await expectNoWaitLeft(page);
      const result = await watched(page);
      // O vigia rodou de verdade durante a espera (quadros contados) e nunca viu a área vazia.
      expect(result.frames).toBeGreaterThan(20);
      expect(result.gaps).toEqual([]);
      if (info.project.name === 's23-fe') {
        expect(result.shift, `saltos: ${result.shifts.join(' | ')}`).toBeLessThan(
          screen.maxShift ?? 0.1,
        );
      }
    });
  }

  test('o servidor do Treino demora: a ficha e o editor ficam em esqueleto até o primeiro puxar acabar', async ({
    context,
    page,
  }) => {
    const server = await mockTrainingApi(context);
    seedTraining(server, {});

    await watchScreen(page);
    const release = await hold(page, '**/api/v1/training/**');
    try {
      await page.goto(`/treino/exercicios/${SEED_EXERCISE_IDS.plank}`);
      await expect.poll(async () => (await watched(page)).seen, { timeout: 8000 }).toBe(true);
      await expect(page.getByRole('heading', { name: 'Prancha isométrica' })).toHaveCount(0);
    } finally {
      release();
    }
    await expect(page.getByRole('heading', { name: 'Prancha isométrica' })).toBeVisible({
      timeout: 25_000,
    });
    await expectNoWaitLeft(page);
    expect((await watched(page)).gaps).toEqual([]);
  });
});
