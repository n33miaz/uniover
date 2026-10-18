# 0002. Monólito modular com módulos extraíveis

- **Status:** Aceito
- **Data:** 18/10/2026

## Contexto

O UniOver reúne assuntos distintos (TV, treino, saúde, monitor, rede, backup, avisos). Microsserviços desde
o início custariam operação e dinheiro demais para um app pessoal em um único contêiner; um monólito sem
fronteiras viraria um bloco impossível de separar. O dono quer poder subir um módulo como deploy separado
mais adiante, sem reescrever.

## Decisão

Um único processo (`UniOver.Host`) compõe módulos com fronteiras rígidas. Resumo das regras:

- cada módulo tem dois projetos: o interior e o `*.Contracts` (API pública).
- um módulo nunca referencia o interior de outro; só `*.Contracts`, `SharedKernel` e `BuildingBlocks`.
- `*.Contracts` não depende de EF nem de ASP.NET.
- cada módulo tem o seu `DbContext`, o seu schema e as suas migrations.
- nenhuma chave estrangeira, join ou view entre schemas; outro módulo só por id.
- um módulo pede algo a outro pela interface de `*.Contracts`.
- efeito em outro módulo é por evento de integração, gravado na outbox na mesma transação.
- registro por `Add<M>Module` e `Map<M>Endpoints`; o `Program.cs` só compõe.
- rotas em `/api/v1/<modulo>/...` e configuração em `Modules:<M>`.
- sem estado estático mutável compartilhado.
- autorização avaliada dentro do próprio módulo.
- sempre ao menos dois módulos reais, para os testes de arquitetura terem o que testar.

Extrair um módulo é: (1) criar um `UniOver.Host.<M>` que chama só `Add<M>Module` e `Map<M>Endpoints`;
(2) trocar nos outros módulos a implementação em processo por um adaptador HTTP da mesma interface;
(3) trocar o adaptador da porta de eventos pelo broker; (4) mover o schema para outro banco, o que é possível
porque não há chave estrangeira cruzada; (5) apontar o proxy de `/api/v1/<modulo>` para o novo serviço, sem
mudar o PWA. Toda revisão pergunta: "este código ainda permite os 5 passos?".

## Consequências

- Um só deploy hoje, com o custo e a simplicidade de um monólito.
- Testes de arquitetura (ArchUnitNET) passam a fazer parte da esteira e quebram o build se uma regra cair.
- Há mais cerimônia por módulo (dois projetos, contratos, eventos) do que num monólito comum.

## Alternativas consideradas

- **Microsserviços desde já:** operação e custo desproporcionais ao tamanho do projeto.
- **Monólito em camadas, sem fronteira de módulo:** o acoplamento cresce e a extração futura fica inviável.
