# 0004. Monorepo com `contracts/` como fonte de verdade entre linguagens

- **Status:** Aceito
- **Data:** 18/10/2026

## Contexto

O projeto tem três peças em três linguagens: API (.NET), PWA (TypeScript) e agente (Python). Elas conversam
por HTTP e por mensagens. Se cada uma definir os próprios tipos à mão, os formatos divergem em silêncio e o
erro só aparece em uso. É um projeto de uma pessoa, então repositórios separados só multiplicariam
sincronização.

## Decisão

Um único repositório (monorepo) com `apps/api`, `apps/web`, `apps/agent`, `contracts/` e `adr/`.

`contracts/` é a fonte de verdade entre linguagens:

- `contracts/http/openapi.json`, gerado pela API e versionado;
- `contracts/agent/`, com o envelope, os schemas das mensagens e o `asyncapi.yaml`.

Os tipos de cada app são **gerados** a partir daí e nunca editados à mão. A esteira gera de novo e falha se
houver diferença. Um app nunca importa arquivo de outro app; só lê `contracts/`. Cada app compila, testa e
roda sozinho a partir da própria pasta, e a esteira só roda o que mudou naquele caminho.

## Consequências

- Uma mudança de contrato e seus consumidores entram no mesmo PR.
- Divergência entre as pontas vira falha de esteira, não bug em produção.
- É preciso manter os geradores de tipos funcionando nas três linguagens.
- A esteira precisa de filtro por caminho para não rodar tudo a cada alteração.

## Alternativas consideradas

- **Um repositório por app:** sincronizar contratos e versões entre repositórios é trabalho constante.
- **Tipos escritos à mão em cada lado:** diverge sem avisar.
- **Contrato definido só no código da API:** o agente em Python e o PWA ficariam dependendo de rodar a API
  para saber o formato.
