import { Routes } from '@angular/router';
import { authGuard } from './core/auth/auth.guard';
import { moduleGuard } from './core/auth/role.guard';
import { welcomeGuard } from './core/auth/welcome.guard';

// Cada módulo de tela é uma rota preguiçosa. O `data.title` de uma rota liga o cabeçalho do shell (com o
// retorno ao Início) e as abas vêm do `data.tabs` da rota filha do próprio módulo. O convidado alcança os módulos que a
// conta dele libera (a TV e o Treino, cada um pela permissão `module:*`) e a parte de Ajustes que é dele (lista, Perfil,
// Aparência, Segurança com as próprias sessões e Sobre): o que sobra leva `ownerOnlyGuard` (e a API recusa com 403 de
// qualquer jeito). Quem não pode usar
// um módulo volta à Início, que mostra somente o que a conta pode abrir.
export const routes: Routes = [
  {
    // O celular onde a pessoa já entrou abre o QR de um computador aqui e confirma. Exige sessão: quem ainda não entrou
    // passa pelo login e volta (o `next` aceita esta rota). Vem antes de `entrar` e fora da casca.
    path: 'entrar/qr',
    canMatch: [authGuard],
    loadComponent: () => import('./core/auth/qr/qr-approve.page').then((m) => m.QrApprovePage),
  },
  {
    path: 'entrar',
    loadComponent: () => import('./core/auth/login.page').then((m) => m.LoginPage),
  },
  {
    path: 'recuperar-senha',
    loadComponent: () =>
      import('./core/auth/request-recovery.page').then((m) => m.RequestRecoveryPage),
  },
  {
    path: 'redefinir-senha',
    loadComponent: () => import('./core/auth/reset-password.page').then((m) => m.ResetPasswordPage),
  },
  {
    // Quem está no PC baixa o conector sem conta: fica fora da casca e sem guarda de login. O arquivo em si
    // (`/conectar/conectar-uniover.cmd`) é estático; só a rota sem arquivo cai neste app.
    path: 'conectar',
    loadComponent: () => import('./modules/devices/connect.page').then((m) => m.ConnectPage),
  },
  {
    // O convite chega por link, sem sessão: fica fora da casca e do guarda de login.
    path: 'convite',
    loadComponent: () => import('./core/auth/accept-invite.page').then((m) => m.AcceptInvitePage),
  },
  {
    // O convite do grupo de Compras chega com o segredo no fragmento: fica fora da casca e sem guarda nenhum (nem de
    // login, nem do módulo), para o segredo nunca ir parar no `?next=`. A própria tela o guarda, limpa o endereço e,
    // sem sessão, manda para o login com `next=/compras/convite`. Vem antes da casca, que pegaria o caminho.
    path: 'compras/convite',
    loadComponent: () =>
      import('./modules/shopping/shopping-join.page').then((m) => m.ShoppingJoinPage),
  },
  {
    // Primeiro acesso: a pergunta do nome fica fora da casca (e do guarda de boas-vindas, para nunca haver laço), mas
    // exige sessão: quem não entrou vai para a tela de entrada.
    path: 'boas-vindas',
    canMatch: [authGuard],
    loadComponent: () => import('./core/auth/welcome.page').then((m) => m.WelcomePage),
  },
  {
    path: '',
    // A casca só existe depois de a sessão e as boas-vindas liberarem uma rota autenticada. Carregá-la aqui evita
    // que o primeiro pacote leve as preferências da Início e a folha de permissão da TV para as telas públicas.
    loadComponent: () => import('./core/layout/app-shell').then((m) => m.AppShell),
    // Entrar primeiro; depois, quem ainda não escolheu o nome responde à pergunta antes de qualquer tela.
    canMatch: [authGuard, welcomeGuard],
    children: [
      {
        path: '',
        pathMatch: 'full',
        loadChildren: () => import('./modules/home/home.routes').then((m) => m.HOME_ROUTES),
      },
      {
        path: 'tv',
        canMatch: [moduleGuard('tv')],
        data: { title: $localize`:@@module.tv.title:TV` },
        loadChildren: () => import('./modules/tv/tv.routes').then((m) => m.TV_ROUTES),
      },
      {
        path: 'treino',
        canMatch: [moduleGuard('training')],
        data: { title: $localize`:@@module.training.title:Treino` },
        loadChildren: () =>
          import('./modules/training/training.routes').then((m) => m.TRAINING_ROUTES),
      },
      {
        path: 'compras',
        canMatch: [moduleGuard('shopping')],
        data: { title: $localize`:@@module.shopping.title:Compras` },
        loadChildren: () =>
          import('./modules/shopping/shopping.routes').then((m) => m.SHOPPING_ROUTES),
      },
      {
        // Como a TV e o Treino, tem manifest e escopo próprios (`public/pc/manifest.webmanifest`).
        path: 'pc',
        canMatch: [moduleGuard('pc')],
        data: { title: $localize`:@@module.pc.title:Controle do PC` },
        loadChildren: () => import('./modules/pc/pc.routes').then((m) => m.PC_ROUTES),
      },
      // Endereços antigos continuam úteis, mas a tela deixou de existir: toda conta tem a própria Início.
      { path: 'sem-acesso', pathMatch: 'full', redirectTo: '/' },
      {
        // Configurações é uma lista; cada linha abre uma tela filha, com a seta voltando para a lista.
        path: 'ajustes',
        data: { title: $localize`:@@settings.title:Configurações`, settings: true },
        loadChildren: () => import('./settings.routes').then((m) => m.SETTINGS_ROUTES),
      },
    ],
  },
  { path: '**', redirectTo: '' },
];
