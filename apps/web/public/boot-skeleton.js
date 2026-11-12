(function () {
  var p = location.pathname.replace(/\/+$/, '') || '/';
  var v = 'home';
  if (p === '/' || p === '/index.html') v = 'home';
  else if (p === '/tv' || p.indexOf('/tv/') === 0) v = 'tv';
  else if (p === '/pc' || p.indexOf('/pc/') === 0) v = 'pc';
  else if (p === '/compras' || p.indexOf('/compras/') === 0) v = 'shopping';
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
  else if (p === '/ajustes/seguranca/siri') v = 'settings-siri';
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
  else if (p === '/recuperar-senha') v = 'auth-recovery';
  else if (p === '/redefinir-senha') v = 'auth-reset';
  else if (p === '/convite') v = 'auth-invite';
  else if (p === '/boas-vindas') v = 'auth-welcome';
  else if (p === '/conectar') v = 'devices-connect';
  document.documentElement.setAttribute('data-boot', v);
  // O esqueleto não sai da tela quando algo trava: sem o app ou sem a folha de estilos, ele fica e oferece "Tentar de Novo".
  var giveUp = function () {
    var el = document.getElementById('boot-skeleton');
    var notice = document.getElementById('boot-timeout');
    if (!el) return;
    el.setAttribute('data-boot-timeout', 'true');
    if (notice) notice.hidden = false;
  };
  // Quantas aberturas seguidas ficaram sem a folha de estilos (a sessão do navegador guarda): na segunda o aviso não
  // adianta mais (o HTML em cache pode apontar para uma folha que o servidor já não tem), então o app é liberado sem estilo.
  var FAILURES_KEY = 'uniover.boot-styles-failures';
  var readFailures = function () {
    try {
      return Number(sessionStorage.getItem(FAILURES_KEY)) || 0;
    } catch (e) {
      return 0;
    }
  };
  var writeFailures = function (count) {
    try {
      if (count) sessionStorage.setItem(FAILURES_KEY, String(count));
      else sessionStorage.removeItem(FAILURES_KEY);
    } catch (e) {
      // Sem armazenamento: cada falha vale como a primeira.
    }
  };
  // A folha principal chega com media="print" (scripts/defer-styles.mjs) para não bloquear a primeira pintura do
  // esqueleto. Ao carregar ela é ligada e o app é avisado: até lá o esqueleto estático continua cobrindo a tela (sem
  // estilo a página não pode aparecer). Se a folha falhar, o esqueleto fica e o aviso com a nova tentativa aparece na hora.
  // Sem o link marcado (servidor de desenvolvimento) não há o que esperar. O atributo data-styles-owner diz ao app que
  // este script cuida da folha; sem ele (script antigo em cache, ou que não rodou) o próprio app assume.
  var sheet = document.querySelector('link[data-boot-styles]');
  if (sheet) {
    var root = document.documentElement;
    root.setAttribute('data-styles', 'pending');
    root.setAttribute('data-styles-owner', 'boot');
    var settle = function (unstyled) {
      if (root.getAttribute('data-styles') === 'ready') return;
      sheet.media = 'all';
      root.setAttribute('data-styles', 'ready');
      if (!unstyled) writeFailures(0);
      document.dispatchEvent(new Event('uniover:styles-ready'));
    };
    var reported = false;
    var failed = function () {
      // A falha pode ser vista duas vezes (o evento e a conferência do registro de recursos): conta uma só.
      if (reported || root.getAttribute('data-styles') === 'ready') return;
      reported = true;
      var count = readFailures();
      writeFailures(count + 1);
      if (count >= 1) settle(true);
      else giveUp();
    };
    // O WebKit dá uma folha vazia a um carregamento que falhou (e negar o acesso às regras): folha sem regras, ou cujas
    // regras não se leem, não é folha carregada. A do app é do mesmo endereço, então a leitura sempre é permitida.
    var hasRules = function () {
      try {
        return !!sheet.sheet && sheet.sheet.cssRules.length > 0;
      } catch (e) {
        return false;
      }
    };
    // A folha que terminou sem virar folha (falhou antes de os ouvintes existirem) aparece no registro de recursos.
    var finishedWithoutSheet = function () {
      try {
        var entries = performance.getEntriesByName(sheet.href);
        return !hasRules() && entries.length > 0 && entries[entries.length - 1].responseEnd > 0;
      } catch (e) {
        return false;
      }
    };
    if (hasRules()) settle();
    // Já terminou, mas a folha veio vazia ou sem regras legíveis (carregamento que falhou antes deste script rodar).
    else if (sheet.sheet) failed();
    else {
      sheet.addEventListener('load', function () {
        if (hasRules()) settle();
        else failed();
      });
      sheet.addEventListener('error', failed);
      setTimeout(function () {
        if (finishedWithoutSheet()) failed();
      }, 1500);
    }
  }
  setTimeout(giveUp, 20000);
  // "Tentar de Novo": antes de recarregar pede ao service worker uma versão nova (o HTML em cache pode ser de uma versão
  // que já saiu do ar); sem service worker, ou se ele demorar, recarrega do mesmo jeito.
  var retry = function () {
    var go = function () {
      location.reload();
    };
    try {
      navigator.serviceWorker
        .getRegistration()
        .then(function (registration) {
          return registration && registration.update();
        })
        .then(go, go);
      setTimeout(go, 3000);
    } catch (e) {
      go();
    }
  };
  document.addEventListener('click', function (event) {
    if (event.target && event.target.id === 'boot-timeout-retry') retry();
  });
})();
