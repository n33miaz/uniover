import { Page } from '@playwright/test';
import { dropConnection, failWith } from '../auth/entry-helpers';
import {
  ALL_PERMISSIONS,
  GUEST,
  IdentityMock,
  MockGuest,
  TV_CONTROL_ONLY,
  mockIdentityApi,
} from '../auth/identity-mock';
import { expect, expectNoHorizontalScroll, test } from '../fixtures';
import { installFakeEventSource, mockTvApi } from '../tv/tv-mock';

// A API é simulada pelas rotas do Playwright, que não enxergam o que passa pelo service worker.
test.use({ serviceWorkers: 'block' });

let mock: IdentityMock;

test.beforeEach(async ({ context }) => {
  mock = await mockIdentityApi(context);
  // Sessão do administrador já aberta: a tela abre direto. A confirmação com a passkey está em vigor em quase todo
  // teste daqui (o WebKit não tem autenticador virtual); os testes do diálogo a desligam de propósito.
  mock.loggedIn = true;
  mock.stepUpValid = true;
});

const TV_SUMMARY = 'Controlar a TV · Desligar a TV · Abrir apps · Ver o histórico';

const BRUNO: MockGuest = {
  id: '00000000-0000-4000-8000-0000000000a1',
  displayName: 'Bruno',
  email: 'bruno@exemplo.com',
  password: 'x',
  createdAt: '2026-10-10T10:00:00Z',
  disabledAt: null,
};
const RAPHAEL: MockGuest = {
  id: '00000000-0000-4000-8000-0000000000a2',
  displayName: 'Raphael',
  email: 'raphael@exemplo.com',
  password: 'x',
  createdAt: '2026-10-12T10:00:00Z',
  disabledAt: null,
  permissions: ['module:training'],
};
const CARLA: MockGuest = {
  id: '00000000-0000-4000-8000-0000000000a3',
  displayName: 'Carla',
  email: 'carla@exemplo.com',
  password: 'x',
  createdAt: '2026-10-05T10:00:00Z',
  disabledAt: '2026-10-12T10:00:00Z',
};

/** Três pessoas (uma revogada), um convite com a TV e outro só com o Treino. */
function seed(): void {
  mock.guests.push({ ...BRUNO }, { ...RAPHAEL }, { ...CARLA });
  mock.seedInvite('Alice');
  mock.seedInvite('Dani', ['module:training']);
}

async function open(page: Page): Promise<void> {
  // Movimento reduzido: o axe e os testes veem a tela já parada (o executor da CI é lento).
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/ajustes/pessoas');
  await expect(page.getByRole('heading', { level: 1, name: 'Pessoas' })).toBeVisible();
}

const invitePosts = () =>
  mock.requests.filter((r) => r.method === 'POST' && r.path === '/guest-invites');
const permissionPuts = () => mock.requests.filter((r) => r.method === 'PUT');

async function startInvite(page: Page, name: string): Promise<void> {
  await page.getByRole('button', { name: 'Convidar alguém' }).click();
  await page.getByLabel('Nome do convidado').fill(name);
}

const permissionsToggle = (page: Page) =>
  page.getByRole('button', { name: /O que essa pessoa poderá fazer/ });
const model = (page: Page, label: string) => page.locator('label.model', { hasText: label });

test.describe('Pessoas: a lista', () => {
  test('quem tem acesso vem primeiro, depois os convites abertos, e o convite novo é só um botão', async ({
    page,
  }) => {
    seed();
    await open(page);

    await expect(page.locator('.person .name')).toHaveText([
      'Bruno',
      'Raphael',
      'Carla',
      'Alice',
      'Dani',
    ]);
    // O resumo de uma linha do que cada um pode fazer (a pessoa revogada não tem).
    await expect(page.locator('.person .abilities')).toHaveText([
      TV_SUMMARY,
      'Usar o Treino',
      TV_SUMMARY,
      'Usar o Treino',
    ]);
    await expect(page.locator('.revoked')).toHaveText('Acesso revogado');
    await expect(page.getByRole('button', { name: /^Permissões de Carla/ })).toHaveCount(0);
    await expect(page.getByRole('heading', { level: 3, name: 'Convites pendentes' })).toBeVisible();

    await expect(page.getByRole('button', { name: 'Convidar alguém' })).toBeVisible();
    await expect(page.locator('form.invite')).toHaveCount(0);
    await expectNoHorizontalScroll(page);
  });

  test('sem ninguém, uma linha só e nenhum título de convites', async ({ page }) => {
    await open(page);
    await expect(page.locator('.empty')).toHaveCount(1);
    await expect(page.getByText('Ninguém foi convidado ainda.')).toBeVisible();
    await expect(page.getByRole('heading', { level: 3 })).toHaveCount(0);
  });

  test('só com convites abertos, nada de bloco vazio para os convidados', async ({ page }) => {
    mock.seedInvite('Alice');
    await open(page);
    await expect(page.locator('.person .name')).toHaveText(['Alice']);
    await expect(page.locator('.empty')).toHaveCount(0);
  });
});

test.describe('Pessoas: convidar escolhendo o que a pessoa poderá fazer', () => {
  const CASES = [
    {
      name: 'o padrão, só controlar a TV',
      pick: null,
      expected: [...TV_CONTROL_ONLY],
      summary: TV_SUMMARY,
    },
    {
      name: 'o modelo só o Treino',
      pick: 'Só o Treino',
      expected: ['module:training'],
      summary: 'Usar o Treino',
    },
    {
      name: 'uma lista personalizada',
      pick: 'Personalizado',
      expected: [...ALL_PERMISSIONS],
      summary:
        'Controlar a TV · Desligar a TV · Abrir apps · Editar atalhos · Ver o histórico · Usar o Treino',
    },
  ] as const;

  for (const scenario of CASES) {
    test(`envia as permissões de ${scenario.name} e entrega o link uma vez`, async ({ page }) => {
      await open(page);
      await startInvite(page, 'Raphael');
      await expect(page.getByLabel('Nome do convidado')).toBeFocused();

      // Recolhido, o seletor deixa o resumo à vista.
      await expect(permissionsToggle(page)).toHaveAttribute('aria-expanded', 'false');
      await expect(permissionsToggle(page)).toContainText(TV_SUMMARY);

      if (scenario.pick) {
        await permissionsToggle(page).click();
        await model(page, scenario.pick).click();
      }
      if (scenario.pick === 'Personalizado') {
        await page.getByRole('switch', { name: 'Editar e reordenar atalhos' }).check();
        await page.getByRole('switch', { name: 'Usar o Treino' }).check();
      }
      await page.getByRole('button', { name: 'Gerar convite' }).click();

      const link = page.getByLabel('Link do convite');
      await expect(link).toBeVisible();
      expect(await link.inputValue()).toMatch(/\/convite#[A-Za-z0-9_-]{43}$/);
      expect(invitePosts()).toHaveLength(1);
      expect(invitePosts()[0].body).toEqual({
        displayName: 'Raphael',
        permissions: scenario.expected,
      });
      expect(mock.invites.at(-1)?.permissions).toEqual(scenario.expected);

      // O link aparece uma vez: fechar o esquece, e o convite fica pendente na lista com o resumo.
      await page.getByRole('button', { name: 'Fechar' }).click();
      await expect(link).toHaveCount(0);
      await expect(
        page.locator('.person', { hasText: 'Raphael' }).locator('.abilities'),
      ).toHaveText(scenario.summary);
      await expect(page.getByRole('button', { name: 'Convidar alguém' })).toBeVisible();
    });
  }

  test('ligar uma ação da TV liga "Ver a TV"; desligar "Ver a TV" desliga as ações', async ({
    page,
  }) => {
    await open(page);
    await startInvite(page, 'Raphael');
    await permissionsToggle(page).click();
    await model(page, 'Só o Treino').click();

    const view = page.getByRole('switch', { name: 'Ver a TV' });
    const edit = page.getByRole('switch', { name: 'Editar e reordenar atalhos' });
    const history = page.getByRole('switch', { name: 'Ver o histórico' });
    await expect(view).not.toBeChecked();

    await edit.check();
    await expect(view).toBeChecked();
    await history.check();
    await expect(history).toBeChecked();

    await view.uncheck();
    await expect(edit).not.toBeChecked();
    await expect(history).not.toBeChecked();
    await expect(page.getByRole('switch', { name: 'Usar o Treino' })).toBeChecked();
    // O que sobrou (só o Treino) bate com um modelo pronto, e é ele que aparece marcado.
    await expect(model(page, 'Só o Treino')).toHaveClass(/on/);
    await expect(model(page, 'Personalizado')).not.toHaveClass(/on/);
  });

  test('sem nenhum módulo ligado não dá para criar, e a tela diz o que fazer', async ({ page }) => {
    await open(page);
    await startInvite(page, 'Raphael');
    await permissionsToggle(page).click();
    await page.getByRole('switch', { name: 'Ver a TV' }).uncheck();

    await expect(page.getByRole('button', { name: 'Gerar convite' })).toBeDisabled();
    await expect(page.getByRole('status').filter({ hasText: 'Ligue ao menos a TV' })).toBeVisible();
    expect(invitePosts()).toHaveLength(0);

    // Ligando um módulo de volta, o botão volta.
    await page.getByRole('switch', { name: 'Usar o Treino' }).check();
    await expect(page.getByRole('button', { name: 'Gerar convite' })).toBeEnabled();
  });

  test('cancelar fecha o cartão, esquece a escolha e não chama a API', async ({ page }) => {
    await open(page);
    await startInvite(page, 'Raphael');
    await permissionsToggle(page).click();
    await model(page, 'Só o Treino').click();
    await page.getByRole('button', { name: 'Cancelar' }).click();
    await expect(page.locator('form.invite')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Convidar alguém' })).toBeFocused();

    await startInvite(page, '');
    await expect(permissionsToggle(page)).toContainText(TV_SUMMARY);
    expect(invitePosts()).toHaveLength(0);
  });

  test('a API recusar o convite aparece no cartão, sem perder o que foi escolhido', async ({
    page,
  }) => {
    await open(page);
    await failWith(page, '/guest-invites', 400, 'validation-failed');
    await startInvite(page, 'Raphael');
    await page.getByRole('button', { name: 'Gerar convite' }).click();
    await expect(page.getByRole('alert')).toContainText('O convite não foi criado');
    await expect(page.getByLabel('Nome do convidado')).toHaveValue('Raphael');
  });
});

test.describe('Pessoas: mudar o que alguém pode fazer', () => {
  const sheetOf = (page: Page, name: string) =>
    page.getByRole('dialog', { name: `Permissões de ${name}` });
  const openSheet = async (page: Page, name: string) => {
    await page.getByRole('button', { name: `Permissões de ${name}` }).click();
    await expect(sheetOf(page, name)).toBeVisible();
    return sheetOf(page, name);
  };

  test('a folha abre marcada com o que a pessoa tem e só deixa salvar o que mudou', async ({
    page,
  }) => {
    seed();
    await open(page);
    const sheet = await openSheet(page, 'Raphael');

    await expect(sheet).toContainText('até 30 segundos');
    await expect(sheet.getByRole('switch', { name: 'Usar o Treino' })).toBeChecked();
    await expect(sheet.getByRole('switch', { name: 'Ver a TV' })).not.toBeChecked();
    await expect(sheet.getByRole('button', { name: 'Salvar' })).toBeDisabled();

    // Mexer e desfazer devolve ao "nada a salvar"; cancelar não chama a API.
    await sheet.getByRole('switch', { name: 'Ver a TV' }).check();
    await expect(sheet.getByRole('button', { name: 'Salvar' })).toBeEnabled();
    await sheet.getByRole('switch', { name: 'Ver a TV' }).uncheck();
    await expect(sheet.getByRole('button', { name: 'Salvar' })).toBeDisabled();
    await sheet.getByRole('button', { name: 'Cancelar' }).click();
    await expect(sheet).toHaveCount(0);
    expect(permissionPuts()).toHaveLength(0);
    await expect(page.getByRole('button', { name: 'Permissões de Raphael' })).toBeFocused();
  });

  test('salvar envia a lista completa, atualiza a linha na hora e volta o foco ao botão', async ({
    page,
  }) => {
    seed();
    await open(page);
    const sheet = await openSheet(page, 'Raphael');

    // Ligar uma ação da TV liga "Ver a TV" junto; o Treino que ele já tinha segue na lista.
    await sheet.getByRole('switch', { name: 'Desligar a TV' }).check();
    await expect(sheet.getByRole('switch', { name: 'Ver a TV' })).toBeChecked();
    await sheet.getByRole('button', { name: 'Salvar' }).click();

    await expect(sheet).toHaveCount(0);
    expect(permissionPuts()).toHaveLength(1);
    expect(permissionPuts()[0].path).toBe(`/guests/${RAPHAEL.id}/permissions`);
    expect(permissionPuts()[0].body).toEqual({
      permissions: ['module:tv', 'tv:power', 'module:training'],
    });
    expect(mock.guests.find((g) => g.id === RAPHAEL.id)?.permissions).toEqual([
      'module:tv',
      'tv:power',
      'module:training',
    ]);

    await expect(page.locator('.person', { hasText: 'Raphael' }).locator('.abilities')).toHaveText(
      'Desligar a TV · Usar o Treino',
    );
    await expect(page.getByText('Permissões de Raphael salvas.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Permissões de Raphael' })).toBeFocused();
    // A linha já mostra o que a API devolveu: nenhuma leitura extra da lista.
    expect(mock.requests.filter((r) => r.method === 'GET' && r.path === '/guests')).toHaveLength(1);
  });

  test('pessoa sem nenhum módulo não pode ser salva, e a folha diz por quê', async ({ page }) => {
    seed();
    await open(page);
    const sheet = await openSheet(page, 'Raphael');
    await sheet.getByRole('switch', { name: 'Usar o Treino' }).uncheck();
    await expect(sheet.getByRole('button', { name: 'Salvar' })).toBeDisabled();
    await expect(
      sheet.getByText('Ligue ao menos a TV ou o Treino', { exact: false }),
    ).toBeVisible();
    expect(permissionPuts()).toHaveLength(0);
  });

  test('sem a confirmação recente a passkey é pedida; cancelar mantém tudo como estava', async ({
    page,
  }) => {
    seed();
    mock.stepUpValid = false;
    await open(page);
    const sheet = await openSheet(page, 'Raphael');
    await sheet.getByRole('switch', { name: 'Ver a TV' }).check();
    await sheet.getByRole('button', { name: 'Salvar' }).click();

    const confirm = page.getByRole('dialog', { name: 'Confirmar a mudança de permissões' });
    await expect(confirm).toBeVisible();
    await expect(confirm).toContainText('mudar as permissões de uma pessoa');
    await confirm.getByRole('button', { name: 'Cancelar' }).click();
    await expect(confirm).toHaveCount(0);

    await expect(sheet.getByRole('alert')).toContainText('não foi confirmada com a passkey');
    await expect(sheet.getByRole('alert')).toContainText('Nada foi alterado');
    await expect(sheet).toBeVisible();
    expect(mock.guests.find((g) => g.id === RAPHAEL.id)?.permissions).toEqual(['module:training']);
    // Só a primeira tentativa foi ao servidor: o pedido não é repetido sem a confirmação.
    expect(permissionPuts()).toHaveLength(1);
  });

  const ERRORS = [
    {
      name: '400: a combinação não foi aceita',
      arrange: (page: Page) =>
        failWith(page, `/guests/${RAPHAEL.id}/permissions`, 400, 'validation-failed'),
      text: 'combinação de permissões não foi aceita',
    },
    {
      name: '403 que não é de passkey: só administrador muda',
      arrange: (page: Page) =>
        failWith(page, `/guests/${RAPHAEL.id}/permissions`, 403, 'forbidden'),
      text: 'Só um administrador',
    },
    {
      name: '429: muitas tentativas',
      arrange: (page: Page) =>
        failWith(page, `/guests/${RAPHAEL.id}/permissions`, 429, 'rate-limited', {
          'retry-after': '9',
        }),
      text: 'Tente de novo em 9 s',
    },
    {
      name: 'sem rede',
      arrange: (page: Page) => dropConnection(page, `/guests/${RAPHAEL.id}/permissions`),
      text: 'Sem conexão com o servidor',
    },
  ] as const;

  for (const scenario of ERRORS) {
    test(`erro ${scenario.name}`, async ({ page }) => {
      seed();
      await open(page);
      const sheet = await openSheet(page, 'Raphael');
      await scenario.arrange(page);
      await sheet.getByRole('switch', { name: 'Ver a TV' }).check();
      await sheet.getByRole('button', { name: 'Salvar' }).click();

      await expect(sheet.getByRole('alert')).toContainText(scenario.text);
      // A pessoa pode tentar de novo: a folha segue aberta e o botão, ativo.
      await expect(sheet.getByRole('button', { name: 'Salvar' })).toBeEnabled();
      expect(mock.guests.find((g) => g.id === RAPHAEL.id)?.permissions).toEqual([
        'module:training',
      ]);
    });
  }

  test('pessoa já revogada em outro lugar: a folha explica, não deixa salvar e a lista se atualiza', async ({
    page,
  }) => {
    seed();
    await open(page);
    const sheet = await openSheet(page, 'Raphael');
    // Outra aba revogou a pessoa enquanto esta folha estava aberta.
    mock.guests.find((g) => g.id === RAPHAEL.id)!.disabledAt = '2026-10-21T09:00:00Z';
    await sheet.getByRole('switch', { name: 'Ver a TV' }).check();
    await sheet.getByRole('button', { name: 'Salvar' }).click();

    await expect(sheet.getByRole('alert')).toContainText('já foi revogado');
    await expect(sheet.getByRole('button', { name: 'Salvar' })).toBeDisabled();
    await sheet.getByRole('button', { name: 'Fechar' }).click();
    await expect(sheet).toHaveCount(0);
    await expect(page.locator('.person', { hasText: 'Raphael' }).locator('.revoked')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Permissões de Raphael' })).toHaveCount(0);
  });

  test('pessoa que sumiu da lista: a folha explica e a lista se atualiza', async ({ page }) => {
    seed();
    await open(page);
    const sheet = await openSheet(page, 'Raphael');
    mock.guests.splice(
      mock.guests.findIndex((g) => g.id === RAPHAEL.id),
      1,
    );
    await sheet.getByRole('switch', { name: 'Ver a TV' }).check();
    await sheet.getByRole('button', { name: 'Salvar' }).click();

    await expect(sheet.getByRole('alert')).toContainText('não está mais na lista');
    await expect(sheet.getByRole('button', { name: 'Salvar' })).toBeDisabled();
    await sheet.getByRole('button', { name: 'Fechar' }).click();
    await expect(page.locator('.person .name')).not.toContainText(['Raphael']);
  });

  test('Esc fecha a folha sem salvar', async ({ page }) => {
    seed();
    await open(page);
    const sheet = await openSheet(page, 'Bruno');
    await sheet.getByRole('switch', { name: 'Editar e reordenar atalhos' }).check();
    await page.keyboard.press('Escape');
    await expect(sheet).toHaveCount(0);
    expect(permissionPuts()).toHaveLength(0);
  });
});

test.describe('Pessoas: quem não é administrador nunca vê a tela', () => {
  test('a convidada é levada à Início e o servidor recusa o que ela chamar à mão', async ({
    context,
    page,
  }) => {
    await mockTvApi(context, mock);
    await installFakeEventSource(page);
    mock.guests.push({
      id: '00000000-0000-4000-8000-000000000051',
      displayName: GUEST.displayName,
      email: GUEST.email,
      password: GUEST.password,
      createdAt: '2026-10-19T15:00:00Z',
      disabledAt: null,
    });
    mock.role = 'guest';
    await page.goto('/ajustes/pessoas');
    await expect(page).toHaveURL(/\/$/);
    await expect(page.locator('.shortcuts a[href="/ajustes/aparelhos"]')).toHaveCount(0);
    await expect(page.getByText('Permissões de', { exact: false })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Convidar alguém' })).toHaveCount(0);
    // A tela dela nunca chamou a rota de administrador.
    expect(permissionPuts()).toHaveLength(0);

    const status = await page.evaluate(async (bearer) => {
      const response = await fetch('/api/v1/identity/guests/x/permissions', {
        method: 'PUT',
        headers: {
          Authorization: 'Bearer ' + bearer,
          'Content-Type': 'application/json',
          // A rota exige a chave (a recusa por permissão é a que vale aqui, como na API real).
          'Idempotency-Key': crypto.randomUUID(),
        },
        body: JSON.stringify({ permissions: ['module:tv', 'tv:edit-shortcuts'] }),
      });
      return response.status;
    }, mock.issuedTokens.at(-1)!);
    expect(status).toBe(403);
  });
});
