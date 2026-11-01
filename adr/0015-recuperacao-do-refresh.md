# 0015. Recuperação do refresh cuja resposta se perdeu, com prova da chave do aparelho

- **Status:** Aceito (exceção à detecção de reuso de 0011)
- **Data:** 31/10/2026

## Contexto

O [0011](0011-autenticacao.md) manda revogar a família inteira quando um refresh já girado reaparece fora de uma
tolerância de 3 segundos. A regra está certa para um token copiado, mas derruba também o dono legítimo quando a
resposta de uma renovação se perde: o iPhone suspende a página do Safari no meio da requisição, o servidor já girou
o token, o cookie novo nunca chega ao aparelho e a próxima tentativa apresenta o cookie antigo. Foi assim que o
convidado que usa iPhone foi deslogado.

Uma primeira proposta aceitava o token antigo por 45 segundos para o mesmo `User-Agent`, e outra assinava um instante
com uma chave única da origem. A revisão recusou as duas: a janela não cobre a suspensão real do iPhone, a prova não
identificava a família nem o token, e o nonce não era consumido no servidor.

## Decisão

A regra estrita continua sendo a regra. Há **uma exceção**, com todas as condições abaixo ao mesmo tempo; qualquer
falha revoga a família como antes.

- **Chave por sessão, no aparelho.** A cada entrada que cria uma sessão (senha, convite aceito, QR) o navegador gera
  um par ECDSA P-256 **não exportável** (WebCrypto), manda só a chave pública (`X-UniOver-Device-Key`) e, depois que
  a entrada deu certo, guarda o par no IndexedDB no lugar do anterior. A API grava a chave pública **uma vez por
  família** (`refresh_device_keys`), nunca a troca, e nunca a aceita numa rotação. Família sem chave (sessão aberta
  antes desta decisão, IndexedDB apagado, navegador sem WebCrypto) não recupera nada: o reuso revoga.
- **Desafio de uso único, emitido pelo servidor.** `POST /auth/refresh/challenge` (anônimo, autenticado só pelo
  cookie, com o cabeçalho de cliente e o limite de refresh) recebe o token que o aparelho guarda e:
  - se ele ainda não girou, responde sem desafio (basta o refresh comum);
  - se girou há pouco, devolve `id.nonce` e a família, guardando só o SHA-256 do nonce, ligado ao token e à família, com
    validade de 2 minutos e substituindo o desafio anterior da família;
  - se não pode ser recuperado, revoga a família (apresentar um token já girado é reuso, aqui ou no refresh).
- **Prova vinculada à família.** O refresh com `X-UniOver-Recovery-Challenge` e `X-UniOver-Recovery-Proof` vale se a
  assinatura (formato r||s) confere com a chave da família sobre
  `uniover-refresh-recovery|v1|<família>|<id do desafio>|<nonce>`. O desafio é consumido por um `UPDATE` condicional
  **antes** de a assinatura ser conferida: vale uma vez, errar o gasta.
- **Janela de minutos, configurável.** O token precisa ter girado há no máximo `RefreshRecoverySeconds` (padrão 600,
  teto de 3600; 0 desliga). Depois disso, reuso comum: revoga.
- **No máximo uma recuperação por token girado, sem cadeia.** O token apresentado e o sucessor que a recuperação
  consumiu ficam marcados (`recovered_at`) e não recuperam de novo. O sucessor precisa estar sem uso, sem revogação e
  sem vencimento; se alguém o usou, o token antigo foi copiado de verdade.
- **Tudo sob a trava da família.** Rotação, recuperação, emissão do desafio, "Sair", revogação de sessão e revogação de
  convidado passam pela mesma trava advisory transacional por família. Assim um refresh em voo termina antes da
  revogação, que alcança o sucessor dele, ou começa depois e encontra tudo revogado.
- **Auditoria.** A recuperação grava `refresh_recovered` (detalhe: segundos desde a rotação). Toda recusa grava
  `refresh_reuse_detected` com o motivo no detalhe (`no-proof`, `no-key`, `window`, `chained`, `successor-used`,
  `challenge-invalid`, `challenge-replayed`, `bad-signature`, `revoked`).
- **Cliente.** Uma renovação por vez (promessa compartilhada na aba e `navigator.locks` entre abas). Uma marca no
  `localStorage` diz "uma renovação começou e não sei como terminou"; só 200 ou 401 a apagam. Com a marca de pé, nenhuma
  tentativa (repetição agendada, intervalo de 30 s, volta ao primeiro plano, página recarregada, outra aba) reenvia o
  cookie como refresh comum: pede o desafio, assina e renova. A repetição rápida espera 6 s (mais que a tolerância de
  3 s). Sem chave local, cai no refresh comum. Nunca há laço.

## Consequências

- O convidado no iPhone volta a renovar depois de uma resposta perdida, mesmo com a página descartada e recarregada,
  desde que volte dentro da janela e o IndexedDB ainda guarde a chave.
- Duas respostas perdidas seguidas (a da renovação e a da recuperação) derrubam a sessão: é o preço de não haver cadeia.
- Quem roubar o cookie sem a chave continua revogando a família ao usá-lo depois de girado. Quem roubar o cookie **e**
  controlar um script na página consegue pedir assinaturas (a chave não sai, mas assina); a CSP estrita do
  [0014](0014-csp-com-nonce.md) é a defesa dessa parte.
- Uma tabela nova de chaves, outra de desafios, uma coluna nova em `refresh_tokens` (migration aditiva) e uma rota
  pública nova na lista de rotas anônimas.
- Não foi provado num Safari de iPhone real que o IndexedDB mantém a chave: sem instalar o app na tela de início o
  Safari pode apagar dados do site depois de 7 dias sem uso. Sem chave o comportamento é o estrito.
- Duas abas que entram ao mesmo tempo disputam o par guardado; quem perde fica sem recuperação até a próxima entrada.

## Alternativas consideradas

- **Manter só a regra estrita:** mais simples e mais segura, mas o aparelho continua sendo deslogado sempre que a
  resposta se perde. Descartada pelo dono em 31/10/2026.
- **Aceitar o token antigo por alguns segundos pelo mesmo `User-Agent`:** o `User-Agent` é texto do cliente, e a janela
  não cobre a suspensão do iPhone.
- **Assinar um instante com uma chave única da origem:** não identifica família nem token, e o instante só impede
  repetição se o servidor guardar o último valor, o que não protege contra quem tem uma assinatura recente.
- **Não girar o refresh (token longo fixo):** acaba com a perda de resposta, mas também com a detecção de cópia.
- **Confirmar a rotação com uma segunda chamada do cliente:** adiciona uma ida e volta a cada renovação e deixa o
  mesmo vazio (a confirmação também pode se perder).
