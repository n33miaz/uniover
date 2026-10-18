# Política de segurança

## Versões suportadas

O UniOver é um projeto pessoal em desenvolvimento ativo. Só a versão em `main` recebe correções de
segurança; não há versões antigas mantidas.

## Como reportar

Envie um e-mail para **ncormino@gmail.com** com o assunto "UniOver: vulnerabilidade", descrevendo o
problema, os passos para reproduzir e o impacto que você enxerga.

Não abra issue pública para falha de segurança: a issue é indexada no instante em que você clica em
enviar, e nada deve ficar público enquanto a correção não sai.

## Prazo de resposta

- Confirmação de recebimento em até 5 dias corridos.
- Avaliação inicial (procede ou não, gravidade) em até 15 dias corridos.
- Correção ou plano de correção comunicado ao relator assim que houver, com crédito se ele quiser.

É um projeto de uma pessoa só: os prazos são de boa-fé, não um contrato.

## Escopo

Vale reportar:

- falhas na API, no PWA ou no agente local deste repositório (autenticação, autorização, injeção,
  vazamento de dados, execução de comando indevida em aparelho);
- segredo ou credencial que tenha entrado no histórico do repositório;
- dependência com vulnerabilidade explorável no uso que o projeto faz dela.

Fora de escopo:

- ataques que exijam acesso físico ao aparelho do dono ou à rede da casa já comprometida;
- negação de serviço por volume, engenharia social e problemas de serviços de terceiros (Render, Neon);
- relatórios de scanner automático sem prova de exploração.

## Segredo neste repositório

Nenhum. As credenciais vivem nas variáveis de ambiente do serviço de hospedagem e em um `.env` local, que é
ignorado pelo git. Se um segredo vazar num commit, **trocar o segredo é o conserto**; remover o commit não é,
porque quem já clonou continua com ele.
