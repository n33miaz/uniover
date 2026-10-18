# 0005. API em .NET 10 e agente em Python

- **Status:** Aceito
- **Data:** 18/10/2026

## Contexto

A API roda na nuvem em um único contêiner e precisa de tipagem forte, bom desempenho em instância pequena e
um ecossistema maduro para autenticação, banco e testes. O agente roda nos aparelhos de casa (começando por
um PC com Windows), precisa falar com bibliotecas de controle de TV e ser fácil de empacotar e atualizar.

## Decisão

- **API:** .NET 10 com ASP.NET Core e minimal API, um grupo de rotas por módulo. Central Package Management,
  SDK fixado em `global.json`, `Nullable` ligado e avisos tratados como erro.
- **Agente:** Python 3.14, gerenciado com `uv`, com `ruff`, `mypy` em modo estrito e `pytest`. As bibliotecas
  de controle de TV (como `androidtvremote2`) existem em Python.

As duas pontas só compartilham `contracts/` (ver ADR 0004).

## Consequências

- Cada ponta usa a ferramenta mais adequada ao seu ambiente de execução.
- O projeto passa a manter duas cadeias de ferramentas e de dependências, além do Node do PWA.
- Os modelos do agente são gerados a partir dos schemas, em vez de compartilhar código com a API.

## Alternativas consideradas

- **Tudo em Python:** menos rigor de tipos na API e testes de arquitetura mais fracos.
- **Tudo em .NET, agente incluso:** as bibliotecas de controle de TV são em Python; reescrevê-las custaria mais
  do que manter a segunda linguagem.
- **Node/TypeScript na API:** permitiria compartilhar tipos com o PWA, mas o dono prefere a plataforma .NET e
  seus testes de arquitetura.
