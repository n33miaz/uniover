# 0013. Fluxo de git: `develop` e `main` protegidas, Conventional Commits, rebase na `develop`, merge na `main`

- **Status:** Aceito
- **Data:** 18/10/2026

## Contexto

O projeto tem uma pessoa como dono e várias ferramentas ajudando, às vezes em paralelo. Sem um fluxo
combinado, o histórico vira uma sequência de commits sem sentido, e uma entrega pela metade pode chegar à
produção. O repositório é público, então o histórico também é uma vitrine.

## Decisão

- Duas branches de longa vida: `develop` (integração) e `main` (produção). As duas são **protegidas**: só
  recebem mudanças por pull request com os checks obrigatórios verdes.
- Trabalho em branches curtas (`feature/...`, `fix/...`, `chore/...`) saindo de `develop`.
- Mensagens no padrão **Conventional Commits** (`feat:`, `fix:`, `chore:`, `docs:`, `test:`, `refactor:`).
- Trabalho entra na `develop` por **rebase and merge**, para manter o histórico linear e cada commit com sentido
  próprio.
- A `develop` entra na `main` por **merge commit** com título no padrão (ex.: `chore: publish ...`). O rebase do
  GitHub sempre reescreve os commits; usado aqui, deixaria `develop` e `main` com os mesmos commits em SHAs
  diferentes e a publicação seguinte em conflito.
- Branch de trabalho é apagada depois do merge, sempre.
- **Um PR por entrega**: uma fatia que compila, passa nos testes e pode ser revertida sozinha.
- A promoção de `develop` para `main` é feita por PR, e é ela que dispara o deploy.

## Consequências

- Histórico linear e legível, com mensagens que podem alimentar um changelog.
- A produção só muda por um caminho verificado pela esteira.
- Rebase exige cuidado ao atualizar branches, e `force-push` só vale em branch própria de trabalho.

## Alternativas consideradas

- **Trabalhar direto na `main`:** sem barreira entre uma ideia e a produção.
- **Merge commit ou squash:** merge commit polui o histórico; squash apaga a granularidade dos commits.
- **Git Flow completo (release e hotfix):** cerimônia demais para um projeto pessoal.
