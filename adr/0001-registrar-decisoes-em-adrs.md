# 0001. Registrar decisões de arquitetura em ADRs

- **Status:** Aceito
- **Data:** 18/10/2026

## Contexto

O UniOver é feito por uma pessoa, com ajuda de várias ferramentas e em várias sessões de trabalho. Sem um
registro escrito, a razão das escolhas se perde entre uma sessão e outra, e a mesma discussão volta a cada
mudança. O repositório é público, então o registro também ajuda quem lê o código para avaliá-lo.

## Decisão

Cada decisão de arquitetura relevante vira um arquivo em `adr/`, numerado em sequência
(`NNNN-titulo-curto.md`), a partir do `0000-template.md`. O arquivo explica o contexto, a decisão, as
consequências e as alternativas descartadas, sempre em pt-BR.

Mudar uma regra de arquitetura exige um ADR novo aprovado **antes** do código. ADR aceito não é reescrito:
é substituído por outro, que o referencia.

## Consequências

- O porquê de cada escolha fica versionado junto do código e pode ser revisado em PR.
- Mudar a arquitetura passa a ter um custo pequeno e explícito (escrever o ADR), o que desencoraja desvios
  por conveniência.
- Há um pouco mais de escrita no início de cada decisão grande.

## Alternativas consideradas

- **Só comentários no código:** não captura decisões que atravessam vários projetos nem as alternativas
  descartadas.
- **Wiki ou documento externo:** sai de sincronia com o código e não passa pela revisão de PR.
- **Não registrar:** o custo é redescobrir o motivo a cada vez.
