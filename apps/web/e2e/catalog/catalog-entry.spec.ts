import { OWNER } from '../auth/identity-mock';
import { dropConnection, failWith } from '../auth/entry-helpers';
import { expect, test } from '../fixtures';
import { snap } from './catalog-kit';
import { bootStack, hold, open, still, waitSkeleton } from './catalog-setup';

// A API é simulada pelas rotas do Playwright, que não enxergam o que passa pelo service worker.
test.use({ serviceWorkers: 'block', timezoneId: 'America/Sao_Paulo', locale: 'pt-BR' });

const M = 'Entrada';
const TOKEN = 'a'.repeat(43);

test('sem sessão: entrar, recuperar senha, redefinir, conectar e convite', async ({
  context,
  page,
}) => {
  const s = await bootStack(context, page, { loggedIn: false });
  const fillLogin = async (password = 'senha-errada') => {
    await page.getByLabel('E-mail').fill(OWNER.email);
    await page.getByLabel('Senha', { exact: true }).fill(password);
  };
  const submit = () => page.getByRole('button', { name: 'Entrar', exact: true }).click();

  const login = { module: M, route: '/entrar', url: '/entrar' };
  await snap(page, { ...login, state: 'vazio', kind: 'padrão' }, () => open(page, '/entrar'));
  await snap(page, { ...login, state: 'vazio', kind: 'padrão', scheme: 'dark' }, () =>
    open(page, '/entrar'),
  );
  await snap(page, { ...login, state: 'campos vazios, ao enviar', kind: 'validação' }, async () => {
    await open(page, '/entrar');
    await submit();
    await expect(page.getByLabel('E-mail')).toHaveAttribute('aria-invalid', 'true');
    await still(page);
  });
  await snap(page, { ...login, state: 'e-mail ou senha incorretos', kind: 'erro' }, async () => {
    await open(page, '/entrar');
    await fillLogin();
    await submit();
    await page.getByRole('alert').waitFor();
  });
  await snap(page, { ...login, state: 'conta bloqueada', kind: 'erro' }, async () => {
    await open(page, '/entrar');
    await fillLogin();
    await failWith(page, '/auth/login', 429, 'login-locked', { 'retry-after': '125' });
    await submit();
    await page.getByRole('alert').waitFor();
    await page.unroute('**/api/v1/identity/auth/login');
  });
  await snap(page, { ...login, state: 'sem rede', kind: 'sem rede' }, async () => {
    await open(page, '/entrar');
    await fillLogin();
    await dropConnection(page, '/auth/login');
    await submit();
    await page.getByRole('alert').waitFor();
    await page.unroute('**/api/v1/identity/auth/login');
  });

  const recover = { module: M, route: '/recuperar-senha', url: '/recuperar-senha' };
  await snap(page, { ...recover, state: 'vazio', kind: 'padrão' }, () =>
    open(page, '/recuperar-senha'),
  );
  await snap(page, { ...recover, state: 'pedido enviado', kind: 'com dados' }, async () => {
    await open(page, '/recuperar-senha');
    await page.getByLabel('E-mail').fill(OWNER.email);
    await page
      .getByRole('button')
      .filter({ hasText: /Enviar|Continuar|Recuperar/ })
      .first()
      .click();
    await page
      .getByRole('status')
      .filter({ hasText: 'Se este e-mail' })
      .or(page.getByRole('alert'))
      .waitFor();
    await still(page);
  });

  const reset = { module: M, route: '/redefinir-senha' };
  const resetLink = `/redefinir-senha#token=${TOKEN}`;
  await snap(page, { ...reset, url: resetLink, state: 'formulário', kind: 'padrão' }, () =>
    open(page, resetLink),
  );
  await snap(
    page,
    { ...reset, url: '/redefinir-senha', state: 'sem o código do link', kind: 'erro' },
    () => open(page, '/redefinir-senha'),
  );

  await snap(
    page,
    { module: M, route: '/conectar', url: '/conectar', state: 'padrão', kind: 'padrão' },
    () => open(page, '/conectar'),
  );

  const invite = { module: M, route: '/convite' };
  const link = `/convite#${s.identity.seedInvite().token}`;
  await snap(page, { ...invite, url: link, state: 'formulário vazio', kind: 'padrão' }, () =>
    open(page, link),
  );
  await snap(
    page,
    { ...invite, url: link, state: 'senha curta e divergente', kind: 'validação' },
    async () => {
      await open(page, link);
      await page.getByLabel('E-mail').fill('ana');
      await page.getByLabel('Senha', { exact: true }).fill('curta1');
      await page.getByLabel('Repita a senha').fill('curta');
      await page.getByLabel('Repita a senha').blur();
      await page.locator('#invite-confirmation-status').waitFor();
      await still(page);
    },
  );
  await snap(page, { ...invite, url: '/convite', state: 'sem link', kind: 'erro' }, () =>
    open(page, '/convite'),
  );
  await snap(
    page,
    { ...invite, url: '/convite#curto', state: 'link incompleto', kind: 'erro' },
    () => open(page, '/convite#curto'),
  );
});

test('com sessão: boas-vindas e confirmação de entrada pelo QR', async ({ context, page }) => {
  const s = await bootStack(context, page);
  s.identity.owner.confirmed = false;
  const welcome = { module: M, route: '/boas-vindas', url: '/boas-vindas' };
  await snap(page, { ...welcome, state: 'pergunta do nome', kind: 'padrão' }, () =>
    open(page, '/boas-vindas'),
  );
  await snap(page, { ...welcome, state: 'nome vazio', kind: 'validação' }, async () => {
    await open(page, '/boas-vindas');
    await page.getByLabel('Seu nome').fill('');
    await page.getByRole('button', { name: 'Continuar' }).click();
    await expect(page.getByLabel('Seu nome')).toHaveAttribute('aria-invalid', 'true');
    await still(page);
  });
  s.identity.owner.confirmed = true;

  const code = 'Qr1aaaaaaaaaaaaa';
  s.identity.qr.requests.push({
    code,
    secret: 'segredo-do-pc',
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    status: 'pending',
  });
  const qr = { module: M, route: '/entrar/qr', url: `/entrar/qr?codigo=${code}` };
  let release: (() => void) | undefined;
  await snap(page, { ...qr, state: 'carregando', kind: 'carregando' }, async () => {
    release = await hold(page, '**/api/v1/identity/auth/qr/info');
    await page.goto(qr.url);
    await waitSkeleton(page);
  });
  // Solta só depois da captura: a resposta não pode chegar antes da foto do esqueleto.
  release?.();
  await snap(page, { ...qr, state: 'pedido do computador', kind: 'padrão' }, () =>
    open(page, qr.url),
  );
  const unknown = '/entrar/qr?codigo=Inexistente1234567';
  await snap(page, { ...qr, url: unknown, state: 'código que não existe', kind: 'erro' }, () =>
    open(page, unknown),
  );
});
