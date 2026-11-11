# 0018. Manifesto assinado para atualização do agente

- **Status:** Aceito
- **Data:** 11/11/2026

## Contexto

O agente baixava o arquivo do commit apontado pelo canal e conferia o zip e os arquivos de
`apps/agent` contra a árvore obtida pela API do GitHub. Quando essa árvore não estava disponível,
por rede ou limite de consultas, ele seguia apenas com a conferência do zip. Isso deixa a raiz de
confiança dependente de uma resposta online que pode falhar justamente durante uma atualização.

## Decisão

Com o segredo de assinatura cadastrado, todo Release publicado inclui `uniover-agent-manifest.json`. O manifesto contém formato, versão,
commit, URL canônica do zip do commit, SHA-256 desse zip e um número crescente (`sequence`, os
segundos Unix da assinatura). Esses campos, em JSON canônico, são
assinados com Ed25519. A privada existe apenas no segredo `AGENT_SIGNING_KEY` do ambiente protegido
de publicação; a lista de públicas confiáveis fica embutida no agente para permitir rotação.

A exigência depende da **chave embutida**, não da presença do manifesto: se bastasse o Release não
trazer o manifesto para o agente seguir, quem controlasse o Release o omitiria. Com a lista de
públicas embutida não vazia, o agente não prepara nada antes de obter um manifesto válido para o
mesmo commit; depois do download, confere o SHA-256 autenticado.

**Anti-rebaixamento.** O agente guarda em `runtime/manifest-sequence.txt` o maior `sequence`
aceito (com o commit) e recusa manifesto de outro commit com número menor ou igual. Sem isso,
quem controlasse o repositório e os Releases repontaria o canal para um commit antigo, de manifesto
ainda válido, e o agente instalaria uma versão vulnerável. O mesmo commit com o mesmo número passa,
por ser a nova tentativa de uma atualização que falhou. Um rollback legítimo exige publicar de novo,
com número novo.

**Árvore do GitHub.** Sem assinatura ativa, a árvore é obrigatória: indisponível ou divergente, o
pacote é recusado, e não existe caminho "só com o zip". Com manifesto válido, ela vira conferência
extra: a falha da consulta (rede, limite da API) não recusa e vira aviso no registro, mas a
divergência recusa. Assim bloquear `api.github.com` não impede atualizações já autenticadas.

O job que assina roda após a criação do Release. Com o segredo cadastrado, assina e anexa o
manifesto, e falha se a chave dele não estiver entre as embutidas quando a lista não é vazia. Sem o
segredo, depende da lista: **com chave embutida no commit publicado o job falha** (não pode sair
versão com chave sem manifesto, pois os agentes dela passariam a exigi-lo e ficariam sem caminho de
atualização); **sem chave embutida** apenas emite `::warning::` e a publicação segue. Não existe
chave "provisória" embutida que bloqueie o Release. A decisão fica em
`sign_agent_manifest.py activation`, coberta por testes.

## Ativação em dois passos

1. **Lista vazia (esta versão).** O agente não consulta o manifesto: segue com zip e árvore
   conferida, e registra uma vez por execução que a assinatura ainda não está ativa. Assim o PC
   do dono não fica preso numa versão sem conseguir atualizar. O dono gera o par com
   `tools/sign_agent_manifest.py generate-key`, cadastra a privada como `AGENT_SIGNING_KEY` no
   ambiente `production` e a pública entra em `MANIFEST_PUBLIC_KEYS` numa versão publicada
   (assinada a partir do Release dela).
2. **Lista com chave real (a partir dessa versão).** Manifesto válido é obrigatório: sem ele,
   assinatura que não confere ou hash diferente, nada é instalado. Agentes anteriores ao passo 1
   seguem o fluxo antigo até instalarem uma versão com a chave.

## Risco aceito: a chave é exposta ao código do checkout

O passo de assinatura injeta `AGENT_SIGNING_KEY` no ambiente e executa
`tools/sign_agent_manifest.py` do checkout. Quem conseguir alterar o repositório e publicar um commit
poderia alterar esse script para vazar a chave (o mascaramento de log não resiste a uma codificação).
Aceito por ora, por decisão do dono, porque quem altera o repositório já controla o que a produção
publica. Mitigação recomendada: assinar num job separado em ambiente protegido com aprovação do dono,
ou rodar só código fixado por SHA de uma ref protegida (ou KMS/HSM via OIDC). Se o risco deixar de ser
aceito, é a primeira coisa a fechar.

## Bootstrap

Enquanto a lista de chaves está vazia, a atualização não é autenticada: o agente confia no que o
repositório anuncia (árvore coerente com o zip). A primeira versão com chave precisa chegar por um
canal em que isso seja aceitável, e só depois dela a atualização passa a ser de fato assinada.

## Consequências

- A disponibilidade do Release e da API de árvore passa a ser requisito para atualizar, não para
  continuar controlando o PC.
- A privada não entra no repositório, em argumentos nem em arquivo da esteira.
- Rotação exige sobrepor públicas por pelo menos uma versão distribuída; remover a antiga antes
  disso deixaria agentes antigos sem aceitar a nova assinatura.
- Esta decisão substitui a raiz de confiança descrita na decisão 0016; as regras de preparo,
  ponteiro, prova e volta atrás daquela decisão continuam válidas.

## Alternativas consideradas

- **Manter a árvore do GitHub como única raiz de confiança:** a indisponibilidade dela levava o
  agente a aceitar só o zip, sem autenticação independente.
- **Aceitar a instalação sem manifesto quando o Release não o traz:** deixaria um atacante omitir
  o manifesto para escapar da assinatura; por isso a exigência vem da chave embutida.
- **Chave "sentinela" embutida que bloqueia o Release até o cadastro:** travava a publicação
  inteira e, com ela, as atualizações do PC do dono.
