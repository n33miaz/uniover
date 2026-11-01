# 0016. Atualização do agente: canal configurável, pacote conferido, prova antes de confiar

- **Status:** Proposto
- **Data:** 31/10/2026

## Contexto

O agente roda no PC do dono e no de quem ele ajuda, e se atualiza sozinho a partir do GitHub. Quem controlar
o ramo de que ele se atualiza executa código nesses PCs; e uma atualização ruim, num PC que ninguém olha,
deixa o agente fora do ar. Até aqui o agente seguia sempre a `main`, baixava o zip do commit sem conferir
nada além de ser um zip, e a versão nova só deixava de estar "em prova" quando o agente parava.

## Decisão

- **Canal por configuração** (`update_channel` no `agent.toml`, `main` ou `develop`). O padrão do código é
  `develop`, porque hoje a `develop` é a produção. Quando a publicação voltar a sair pela `main`, trocam-se
  `DEFAULT_CHANNEL`, o padrão `-Ref` do instalador e o endereço do `conectar-uniover.cmd` (um teste confere que
  os três concordam).
- **Pacote conferido antes de trocar a pasta:** o zip precisa estar inteiro (CRC) e ter, no comentário, o
  commit pedido (o GitHub o grava); cada arquivo de `apps/agent` é comparado com a árvore do commit pela API
  do GitHub (hash do git, com ou sem conversão de fim de linha). Divergência recusa o pacote; árvore
  indisponível (rede, limite de consultas) não trava a atualização e fica dito no registro.
- **Dependências fixas:** `uv sync --frozen` na candidata, no supervisor e no instalador: instala exatamente o
  `uv.lock`, sem reescrevê-lo. A CI continua com `--locked` (barra lock fora de dia); no PC o `--locked` só
  acrescentaria uma forma de falhar, por exemplo uma versão nova do `uv` que reescreveria o lock.
- **Ensaio da candidata:** além do `uv sync` num ambiente descartável, ela roda o próprio auto-diagnóstico
  (`python -m uniover_agent.selfcheck`: código, contratos e o `agent.toml` real deste PC com as regras novas).
- **Prova com confirmação:** a versão nova fica "em prova" até rodar 10 minutos seguidos com o pulso em dia
  (o supervisor confirma); enquanto está em prova não se atualiza de novo, para não apagar `app.previous`,
  a última versão que se provou boa. Três quedas rápidas, um pulso mudo ou um auto-diagnóstico crítico voltam
  para a anterior.
- **Capacidade nova só depois da API:** o `hello` do agente declara `agent.diagnostics.v1` (e o agente envia
  diagnóstico) somente depois de `GET devices/info` listá-la em `features`; uma API anterior recusa capacidade
  que não conhece, e o deploy em que o agente chega antes da API não pode tirá-lo do ar. Antes disso, as
  ocorrências ficam na fila local limitada.
- Atualização que falha tenta de novo em 30 min, 1 h, 2 h... (teto de 6 h), não só na próxima janela.

## Consequências

- Corrupção ou troca do pacote no caminho é barrada; o ramo em si continua sendo a raiz de confiança. Não
  se exige assinatura nem CI verde: os commits da `develop` não trazem assinatura garantida e a esteira não
  publica um check na própria `develop` que o agente possa consultar.
- Não há trava contra voltar a um commit mais antigo: ao trocar de `develop` para `main`, a `main` pode estar
  atrás, e a troca de canal precisa ser possível.
- A conferência de árvore faz quatro consultas à API do GitHub por atualização (limite anônimo de 60/h por IP).

## Alternativas consideradas

- **Exigir commit assinado ou CI verde:** barraria toda atualização enquanto a `develop` não tiver isso.
- **Manifesto de hashes versionado:** um manifesto desatualizado barraria todos os PCs; a árvore do próprio
  Git já é o manifesto, sem passo manual.
- **Trava contra retrocesso de commit:** impede voltar de canal.
