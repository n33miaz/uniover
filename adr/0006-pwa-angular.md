# 0006. PWA em Angular 22 com Workbox, servido pela própria API

- **Status:** Aceito
- **Data:** 18/10/2026

## Contexto

O dono usa o app principalmente no celular, às vezes sem boa conexão, e quer ícone próprio por módulo na tela
inicial. Um app nativo exigiria loja e dois projetos. Servir o front de outra origem obrigaria a ter CORS,
tokens em lugares mais expostos e dois deploys.

## Decisão

- O front é um **PWA em Angular 22**: componentes standalone, sem zone.js (zoneless) e com signals. Cada
  módulo é uma rota preguiçosa (lazy), e um módulo nunca importa de outro; só de `core/` e `shared/`.
- **Workbox** cuida do cache e do funcionamento offline; escritas offline passam por uma fila local (Dexie)
  com chave de idempotência, e o servidor aceita reenvio.
- Um manifest por módulo, com `id` e `scope` estáveis, para o ícone próprio de cada um.
- O PWA é **servido pela própria API, na mesma origem**: sem CORS, e o cookie de refresh e o SSE autenticam
  sem expor token na URL.
- Textos de tela sempre via i18n (pt-BR); acessibilidade e telas testadas em 390x664 e 411x800.

## Consequências

- Um deploy só (imagem única com o build do web dentro da API).
- Superfície de segurança menor: sem CORS e com CSP estrita.
- O web fica acoplado ao ciclo de deploy da API; separar exigiria um proxy por rota.
- Funcionar offline exige disciplina: toda escrita passa pela fila e toda rota de escrita é idempotente.

## Alternativas consideradas

- **App nativo ou Flutter/React Native:** loja, assinatura e dois ciclos de entrega, sem ganho para o caso.
- **Front em hospedagem separada:** exige CORS e mais um deploy.
- **Outro framework web (React, Vue):** sem vantagem específica; o dono escolheu o Angular.
