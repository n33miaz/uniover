// Escolhe, pelo endereço, qual esqueleto estático do index.html aparece antes de o app subir. Roda sem esperar o Angular
// (é a primeira coisa do <head>) e só marca a raiz; o desenho em si é CSS. A regra é a mesma de `boot-variant.ts`.
(function () {
  var p = location.pathname;
  var v = 'generic';
  if (p === '/' || p === '/index.html') v = 'home';
  else if (/^\/tv(\/|$)/.test(p)) v = 'tv';
  else if (/^\/treino(\/|$)/.test(p)) v = 'training';
  else if (/^\/ajustes\/?$/.test(p)) v = 'settings';
  else if (/^\/ajustes\//.test(p)) v = 'detail';
  else if (/^\/(entrar|convite|boas-vindas|conectar)(\/|$)/.test(p)) v = 'plain';
  document.documentElement.setAttribute('data-boot', v);
  // Se o app não subir em 20 s (falha de carga), o desenho sai: um brilho eterno diria que algo ainda está chegando.
  setTimeout(function () {
    var el = document.getElementById('boot-skeleton');
    if (el) el.className += ' bs-stale';
  }, 20000);
})();
