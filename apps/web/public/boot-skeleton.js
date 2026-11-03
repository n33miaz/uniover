(function () {
  var p = location.pathname.replace(/\/+$/, '') || '/';
  var v = 'home';
  if (p === '/' || p === '/index.html') v = 'home';
  else if (p === '/tv' || p.indexOf('/tv/') === 0) v = 'tv';
  else if (p === '/treino/sessao/exercicio') v = 'training-session-exercise';
  else if (p === '/treino/sessao') v = 'training-session';
  else if (p === '/treino/glossario') v = 'training-glossary';
  else if (/^\/treino\/exercicios\/[^/]+\/editar$/.test(p) || p === '/treino/exercicios/novo')
    v = 'training-exercise-form';
  else if (p === '/treino/exercicios/mapa') v = 'training-map';
  else if (/^\/treino\/exercicios\/[^/]+$/.test(p)) v = 'training-exercise-detail';
  else if (p === '/treino/exercicios') v = 'training-library';
  else if (p === '/treino/rotinas') v = 'training-routines';
  else if (p.indexOf('/treino/rotinas/') === 0) v = 'training-routine-editor';
  else if (p === '/treino/progresso') v = 'training-progress';
  else if (p === '/treino/alimentacao') v = 'training-food';
  else if (p === '/treino/corpo/avaliacoes/importar') v = 'training-assessment-import';
  else if (
    p === '/treino/corpo/avaliacoes/nova' ||
    /^\/treino\/corpo\/avaliacoes\/[^/]+\/editar$/.test(p)
  )
    v = 'training-assessment-editor';
  else if (/^\/treino\/corpo\/avaliacoes\/[^/]+$/.test(p)) v = 'training-assessment-detail';
  else if (p === '/treino/corpo/avaliacoes') v = 'training-assessments';
  else if (p === '/treino/corpo') v = 'training-body';
  else if (p === '/treino') v = 'training-today';
  else if (p === '/ajustes') v = 'settings';
  else if (p === '/ajustes/perfil') v = 'settings-profile';
  else if (p === '/ajustes/aparencia') v = 'settings-appearance';
  else if (p === '/ajustes/seguranca') v = 'settings-security';
  else if (p === '/ajustes/pessoas') v = 'settings-people';
  else if (p === '/ajustes/tvs-por-pessoa') v = 'settings-tv-people';
  else if (/^\/ajustes\/tv\/[^/]+\/historico$/.test(p)) v = 'settings-tv-history';
  else if (p === '/ajustes/auditoria') v = 'settings-audit';
  else if (p === '/ajustes/sistema') v = 'settings-system';
  else if (p === '/ajustes/dispositivos' || p === '/ajustes/aparelhos') v = 'settings-devices';
  else if (p === '/ajustes/sobre/creditos' || p === '/ajustes/creditos') v = 'settings-credits';
  else if (p === '/ajustes/sobre') v = 'settings-about';
  else if (p === '/entrar/qr') v = 'auth-qr';
  else if (p === '/entrar') v = 'auth-login';
  else if (p === '/convite') v = 'auth-invite';
  else if (p === '/boas-vindas') v = 'auth-welcome';
  else if (p === '/conectar') v = 'devices-connect';
  document.documentElement.setAttribute('data-boot', v);
  setTimeout(function () {
    var el = document.getElementById('boot-skeleton');
    var notice = document.getElementById('boot-timeout');
    if (!el) return;
    el.setAttribute('data-boot-timeout', 'true');
    if (notice) notice.hidden = false;
  }, 20000);
  document.addEventListener('click', function (event) {
    if (event.target && event.target.id === 'boot-timeout-retry') location.reload();
  });
})();
