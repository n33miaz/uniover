# 0012. Material de terceiros com licença própria em `assets-third-party/`

- **Status:** Aceito
- **Data:** 18/10/2026

## Contexto

O app usa material que não é do projeto, como as ilustrações de exercícios da Everkinetic (CC BY-SA 4.0) e
dados importados de terceiros, como o catálogo de exercícios do wger. O código do UniOver tem licença
proprietária, com código à vista; misturar o material de terceiros a ela sem separação criaria dúvida sobre
quais termos valem para cada arquivo e poderia violar a licença original.

## Decisão

- Todo material de terceiros em arquivo fica em `assets-third-party/<fonte>/`, junto do `LICENSE` original e
  de um `NOTICE` (origem, autor, versão, data de obtenção).
- Os arquivos entram **sem modificação**. Adaptações vivem fora da pasta e respeitam o que a licença exige.
- O crédito aparece na tela onde o material é usado (por exemplo, "Ilustração: Everkinetic, CC BY-SA 4.0").
- A licença do UniOver **não se aplica** a esse material; isso está dito no `LICENSE` e no README da pasta.
- Dados importados em tempo de execução (wger) guardam `license` e `license_author` por registro.

## Consequências

- Fica claro, arquivo por arquivo, qual licença vale.
- Cumprir a atribuição exige que a interface sempre exiba o crédito junto do material.
- Adicionar uma nova fonte tem um pequeno custo de checklist (LICENSE, NOTICE, crédito).

## Alternativas consideradas

- **Misturar o material às pastas dos apps:** perde-se a rastreabilidade da licença.
- **Aplicar a licença do UniOver a tudo:** inválido para material de terceiros.
- **Evitar material de terceiros:** o custo de produzir ilustrações e catálogo próprios é alto demais.

## Atualização (19/10/2026): material usado só pelo PWA mora em `apps/web/assets-third-party/`

O Angular só publica arquivos (`assets`) de dentro da raiz do workspace do app (`apps/web`); apontar para uma
pasta fora dela faz o build falhar ("asset path must be within the workspace root"). Por isso o material de
terceiros que **só o PWA usa e publica** (as ilustrações do Everkinetic) fica em
`apps/web/assets-third-party/<fonte>/`, e não na pasta da raiz.

- A regra não muda: uma subpasta por fonte, com o `LICENSE` original e um `NOTICE`, arquivos sem modificação,
  crédito na tela, e a licença do UniOver não se aplica a eles.
- O material usado por outras partes (por exemplo, a semente do catálogo lida pela API) continua em
  `assets-third-party/<fonte>/` na raiz.
- A imagem do Docker já copia `apps/web/` inteiro na etapa do PWA, então a pasta nova entra no build sem ajuste.
