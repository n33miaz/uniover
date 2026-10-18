# 0009. Postgres (Neon) com um schema e um DbContext por módulo, sem chave estrangeira entre módulos

- **Status:** Aceito
- **Data:** 18/10/2026

## Contexto

Os módulos precisam poder virar deploys separados no futuro (ADR 0002). Se eles compartilharem tabelas ou
tiverem chaves estrangeiras entre si, separar o banco depois exigiria uma migração de dados arriscada. O
projeto precisa de um Postgres gerenciado, barato e que não obrigue a manter servidor próprio.

## Decisão

- Banco **Postgres no Neon**. Cada módulo tem um **schema** próprio (nome do módulo em snake_case) e um
  **`DbContext`** próprio, com a tabela de histórico de migrations dentro do seu schema.
- **Nenhuma chave estrangeira, join, view ou consulta entre schemas.** Um módulo referencia outro só por id
  (UUID v7).
- Migrations EF Core por módulo, aplicadas pela esteira com um papel **dono** (DDL). A aplicação conecta com
  um papel **runtime**, sem DDL. Migration aplicada é imutável: corrige-se com uma migration nova.
- A aplicação usa o pooler do Neon; migrations e `LISTEN/NOTIFY` usam a conexão direta (o pooler é PgBouncer
  em modo transação).
- Nunca SQL montado por concatenação; só LINQ ou `FromSql` parametrizado.

## Consequências

- Um schema pode ir para outro banco sem migrar dados entre módulos.
- A integridade entre módulos é responsabilidade da aplicação e dos eventos, não do banco; um teste lista
  chaves estrangeiras entre schemas e falha se houver alguma.
- Relatórios que cruzam módulos precisam ser montados na aplicação ou por eventos.

## Alternativas consideradas

- **Um schema compartilhado com chaves estrangeiras:** mais simples hoje, impede a extração amanhã.
- **Um banco por módulo desde já:** custo e operação desnecessários neste porte.
- **Supabase ou banco próprio:** o Neon atende, com plano gratuito e ramificação de bancos para teste.
