# 0014. CSP estrita com nonce por requisição, gerado pela API e injetado no `index.html`

- **Status:** Aceito
- **Data:** 18/10/2026

## Contexto

O app é um PWA em Angular servido pela própria API. Uma Content-Security-Policy sem `unsafe-inline` é a
principal defesa contra injeção de script e de estilo. O problema é que o Angular injeta os estilos dos
componentes em tempo de execução, e o build de produção ainda costumava embutir um `<style>` com o CSS crítico
no `index.html`. Com uma política estrita, nada disso funcionaria sem uma forma de autorizar esses estilos.

## Decisão

- A CSP não usa `unsafe-inline` em diretiva nenhuma. Scripts vêm só de `'self'`; estilos vêm de `'self'` e de
  um **nonce**.
- A API gera um nonce novo (16 bytes aleatórios) **por requisição**. A mesma instância escopada alimenta o
  cabeçalho `Content-Security-Policy` e o `index.html`, então os dois sempre combinam.
- O `index.html` publicado guarda o marcador `__CSP_NONCE__`. Ao entregar a página, a API troca o marcador pelo
  nonce da requisição. O `<app-root>` leva `ngCspNonce="__CSP_NONCE__"`, e é assim que o Angular passa o nonce
  aos estilos que ele injeta.
- O CSS crítico embutido (`inlineCritical`) fica **desligado no build de produção**: ele criava um `<style>` e
  um `<script>` sem nonce, e a página ficaria sem estilo.
- Os cabeçalhos são escritos no início da resposta, para sobreviver à limpeza que o tratador de exceções faz.

## Consequências

- Estilo ou script em linha sem nonce passa a ser bloqueado: bibliotecas novas precisam funcionar sem eles.
  Os testes de ponta a ponta do PWA falham em qualquer violação de CSP, o que pega esse caso cedo.
- O `index.html` não pode ser servido como arquivo estático cru; só a API o entrega, e o arquivo cru fica
  escondido do servidor de arquivos.
- **Service worker:** a página guardada em cache pelo worker carrega o nonce e o cabeçalho **da mesma
  resposta**, então o par continua coerente offline e a página não quebra (verificado nos testes de ponta a
  ponta, sem violação de CSP). O custo é que o nonce fica "congelado" naquela cópia até a próxima versão do
  worker, que renova o cache. Por isso nunca se deve servir HTML antigo com a CSP de outra época.
- Qualquer mudança no formato do marcador exige alterar API, `index.html` e servidor de testes juntos.

## Alternativas consideradas

- **Hash dos estilos e scripts:** exigiria recalcular a cada build do Angular e não cobre os estilos que o
  Angular injeta em tempo de execução, que não existem no arquivo.
- **`unsafe-inline` em `style-src`:** resolveria o problema de estilos, mas abre a porta que a CSP existe para
  fechar.
- **Nonce fixo no build:** um valor previsível não protege nada; o nonce só vale se for imprevisível a cada
  resposta.
