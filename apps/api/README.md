# UniOver.Api

API modular em .NET 10 (monólito modular). Regras e motivos em [`adr/0002`](../../adr/0002-monolito-modular.md) e [`adr/0003`](../../adr/0003-fatias-verticais-e-portas.md).

## Comandos

```
dotnet build UniOver.slnx -warnaserror
dotnet test --solution UniOver.slnx
dotnet run --project src/UniOver.Host          # respeita a variável PORT quando existe
```

## Criar um módulo novo

1. Copie `src/Modules/Tv` (os dois projetos: `UniOver.Modules.<M>` e `UniOver.Modules.<M>.Contracts`).
2. Exponha `Add<M>Module` e `Map<M>Endpoints`; rotas em `/api/v1/<m>`; configuração em `Modules:<M>`.
3. Referencie só `*.Contracts` de outros módulos, `UniOver.SharedKernel` e `UniOver.BuildingBlocks.*`.
4. Registre no `Program.cs` do Host, no `UniOver.slnx` e como referência dos projetos de teste de arquitetura.
   Os testes de arquitetura descobrem o módulo pelo nome `UniOver.Modules.*`; não é preciso editá-los.
5. Linha nova na tabela de módulos da arquitetura exige ADR antes.
