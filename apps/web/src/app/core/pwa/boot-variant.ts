/** Qual desenho cobre cada página. O seletor inicial usa a mesma ordem de rotas. */
export type BootVariant =
  | 'home'
  | 'tv'
  | 'training-today'
  | 'training-session'
  | 'training-session-exercise'
  | 'training-glossary'
  | 'training-library'
  | 'training-exercise-form'
  | 'training-map'
  | 'training-exercise-detail'
  | 'training-routines'
  | 'training-routine-editor'
  | 'training-progress'
  | 'training-food'
  | 'training-body'
  | 'training-assessments'
  | 'training-assessment-import'
  | 'training-assessment-editor'
  | 'training-assessment-detail'
  | 'settings'
  | 'settings-profile'
  | 'settings-appearance'
  | 'settings-security'
  | 'settings-siri'
  | 'settings-people'
  | 'settings-tv-people'
  | 'settings-tv-history'
  | 'settings-audit'
  | 'settings-system'
  | 'settings-devices'
  | 'settings-about'
  | 'settings-credits'
  | 'auth-login'
  | 'auth-recovery'
  | 'auth-reset'
  | 'auth-qr'
  | 'auth-invite'
  | 'auth-welcome'
  | 'devices-connect';

/** Aceita o caminho puro (`/tv/`) ou um endereço inteiro do roteador (`/tv?painel=apps#x`). */
export function bootVariantFor(path: string): BootVariant {
  const pathname = path.split(/[?#]/, 1)[0]?.replace(/\/+$/, '') || '/';
  if (pathname === '/' || pathname === '/index.html') return 'home';
  if (pathname === '/tv' || pathname.startsWith('/tv/')) return 'tv';
  if (pathname === '/treino/sessao/exercicio') return 'training-session-exercise';
  if (pathname === '/treino/sessao') return 'training-session';
  if (pathname === '/treino/glossario') return 'training-glossary';
  if (
    /^\/treino\/exercicios\/[^/]+\/editar$/.test(pathname) ||
    pathname === '/treino/exercicios/novo'
  )
    return 'training-exercise-form';
  if (pathname === '/treino/exercicios/mapa') return 'training-map';
  if (/^\/treino\/exercicios\/[^/]+$/.test(pathname)) return 'training-exercise-detail';
  if (pathname === '/treino/exercicios') return 'training-library';
  if (pathname === '/treino/rotinas') return 'training-routines';
  if (pathname.startsWith('/treino/rotinas/')) return 'training-routine-editor';
  if (pathname === '/treino/progresso') return 'training-progress';
  if (pathname === '/treino/alimentacao') return 'training-food';
  if (pathname === '/treino/corpo/avaliacoes/importar') return 'training-assessment-import';
  if (
    pathname === '/treino/corpo/avaliacoes/nova' ||
    /^\/treino\/corpo\/avaliacoes\/[^/]+\/editar$/.test(pathname)
  )
    return 'training-assessment-editor';
  if (/^\/treino\/corpo\/avaliacoes\/[^/]+$/.test(pathname)) return 'training-assessment-detail';
  if (pathname === '/treino/corpo/avaliacoes') return 'training-assessments';
  if (pathname === '/treino/corpo') return 'training-body';
  if (pathname === '/treino') return 'training-today';
  if (pathname === '/ajustes') return 'settings';
  if (pathname === '/ajustes/perfil') return 'settings-profile';
  if (pathname === '/ajustes/aparencia') return 'settings-appearance';
  if (pathname === '/ajustes/seguranca') return 'settings-security';
  if (pathname === '/ajustes/seguranca/siri') return 'settings-siri';
  if (pathname === '/ajustes/pessoas') return 'settings-people';
  if (pathname === '/ajustes/tvs-por-pessoa') return 'settings-tv-people';
  if (/^\/ajustes\/tv\/[^/]+\/historico$/.test(pathname)) return 'settings-tv-history';
  if (pathname === '/ajustes/auditoria') return 'settings-audit';
  if (pathname === '/ajustes/sistema') return 'settings-system';
  if (pathname === '/ajustes/dispositivos' || pathname === '/ajustes/aparelhos')
    return 'settings-devices';
  if (pathname === '/ajustes/sobre/creditos' || pathname === '/ajustes/creditos')
    return 'settings-credits';
  if (pathname === '/ajustes/sobre') return 'settings-about';
  if (pathname === '/entrar/qr') return 'auth-qr';
  if (pathname === '/entrar') return 'auth-login';
  if (pathname === '/recuperar-senha') return 'auth-recovery';
  if (pathname === '/redefinir-senha') return 'auth-reset';
  if (pathname === '/convite') return 'auth-invite';
  if (pathname === '/boas-vindas') return 'auth-welcome';
  if (pathname === '/conectar') return 'devices-connect';
  // Uma rota desconhecida redireciona para a Início; não existe uma tela genérica.
  return 'home';
}
