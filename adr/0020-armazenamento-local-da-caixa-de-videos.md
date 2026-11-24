# 0020. Armazenamento local da caixa de vídeos

- **Status:** Proposto
- **Data:** 24/11/2026

## Contexto

A caixa de vídeos é a entrada rápida do PWA para links compartilhados pelo celular: o sistema operacional
entrega o share pelo Web Share Target (`/videos/compartilhar`) e o link precisa ficar salvo na hora, mesmo sem
rede. Cada item guarda URL canônica, plataforma, título, data de captura e o texto bruto do share. Os itens
ficam em IndexedDB (Dexie), num banco por conta, `uniover-videos-<accountId>`; o share recebido antes da
gravação fica por instantes em `sessionStorage` (ou `localStorage`, se o primeiro falhar).

As forças em jogo são usabilidade sem atrito (compartilhar e sair, sem tela de desbloqueio) contra
confidencialidade (os links revelam interesses do dono). A auditoria de segurança pediu um modelo
de ameaças explícito. As ameaças analisadas:

- **Script na mesma origem:** lê qualquer IndexedDB da origem. A defesa é a CSP estrita com nonce (ADR 0014),
  sem `unsafe-inline` e com scripts só de `'self'`.
- **Extensão do navegador com permissão no site:** lê o armazenamento e o DOM da página aberta; nada que rode
  na página consegue se esconder dela.
- **Aparelho compartilhado ou desbloqueado:** quem usa o mesmo perfil do navegador vê o que o app mostra.

## Decisão

- Vamos **aceitar o risco** de guardar os itens da caixa em texto claro no IndexedDB, sem criptografia por
  chave de sessão, no mesmo modelo da fila offline do PWA (Dexie, ADR 0006, separada da outbox do servidor no
  ADR 0010).
- A proteção no navegador repousa sobre a **política de mesma origem**, a **CSP estrita com nonce** (ADR 0014)
  e o **isolamento lógico por conta** (um banco por id de conta). Esse isolamento evita que contas misturem
  dados no mesmo aparelho; ele não é barreira contra código que já roda na origem.
- Proteção contra acesso físico fica a cargo do bloqueio do aparelho e do perfil do sistema operacional.

## Consequências

- Compartilhar é instantâneo e funciona offline; a caixa abre e navega sem rede e sem pedir senha a cada share.
- Risco aceito: extensão com permissão na origem, ou quem tiver acesso físico ao aparelho desbloqueado, vê os
  links salvos localmente.
- Passa a ser obrigatório manter a CSP do ADR 0014 sem afrouxar e não guardar na caixa nada além do link e
  seus metadados (nunca token, senha ou conteúdo baixado). Guardar dado mais sensível exige ADR novo.

## Alternativas consideradas

- **Criptografia simétrica com chave derivada de senha (WebCrypto):** exigiria autenticar ou desbloquear em
  segundo plano durante o fluxo do Web Share Target, um atrito extremo para salvar um link. E não protege de
  extensões, que leem o DOM ativo já com os dados decifrados.
- **Armazenamento só no servidor, sem IndexedDB local:** impede receber shares offline e navegar na caixa sem
  conectividade.
