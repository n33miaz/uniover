using UniOver.BuildingBlocks.Web;

namespace UniOver.Modules.Identity.Domain;

/// <summary>Resultado de conferir uma lista de permissões pedida (convite ou edição): a lista normalizada ou os códigos de erro.</summary>
public sealed record PermissionValidation(IReadOnlyList<string> Permissions, IReadOnlyList<string> Errors)
{
    public bool IsValid => Errors.Count == 0;
}

/// <summary>
/// Regras de uma lista de permissões concedidas: só o catálogo (<see cref="AccessPermissions"/>), sem permissão
/// desconhecida, com ao menos um módulo, e toda permissão de ação precisa do módulo dela. Funções puras: a mesma
/// conferência vale para criar convite, aceitar convite e editar depois.
/// </summary>
public static class PermissionRules
{
    /// <summary>Teto de itens aceitos num pedido: o catálogo tem poucas permissões, listas enormes são abuso.</summary>
    public const int MaxRequestedItems = 32;

    public const string ErrorRequired = "permissions-required";
    public const string ErrorTooMany = "permissions-too-many";
    public const string ErrorUnknown = "permissions-unknown";
    public const string ErrorNoModule = "permissions-no-module";
    public const string ErrorMissingModule = "permissions-missing-module";

    /// <summary>
    /// Modelo "só controle da TV": EXATAMENTE o que a convidada que já existe tem hoje (a TV inteira, desligar inclusive,
    /// mas sem editar atalhos, que só o dono fazia). É o padrão do convite sem lista e o que a migration concede aos
    /// convidados que já existiam; a migration tem a lista escrita à mão (uma migration aplicada não muda) e um teste
    /// compara as duas.
    /// </summary>
    public static IReadOnlyList<string> TvControlOnly { get; } =
    [
        AccessPermissions.TvModule,
        AccessPermissions.TvControl,
        AccessPermissions.TvPower,
        AccessPermissions.TvLaunch,
        AccessPermissions.TvHistory,
    ];

    /// <summary>Modelo "só Treino": o módulo e nada da TV.</summary>
    public static IReadOnlyList<string> TrainingOnly { get; } = [AccessPermissions.TrainingModule];

    /// <summary>
    /// Confere e normaliza: sem repetidas, na ordem do catálogo. Lista ausente ou vazia, item desconhecido (caixa e
    /// espaços contam), item nulo, lista sem nenhum módulo e ação sem o módulo dela são recusados. Nenhum erro repete o
    /// valor recebido.
    /// </summary>
    public static PermissionValidation Validate(IReadOnlyCollection<string?>? requested)
    {
        if (requested is null)
        {
            return new PermissionValidation([], [ErrorRequired]);
        }

        if (requested.Count > MaxRequestedItems)
        {
            return new PermissionValidation([], [ErrorTooMany]);
        }

        var errors = new List<string>();
        var chosen = new HashSet<string>(StringComparer.Ordinal);
        var unknown = false;
        foreach (var item in requested)
        {
            if (AccessPermissions.IsKnown(item))
            {
                chosen.Add(item!);
            }
            else
            {
                unknown = true;
            }
        }

        if (unknown)
        {
            errors.Add(ErrorUnknown);
        }

        // Lista vazia cai aqui também: sem módulo não há acesso a nada, e retirar todo o acesso é revogar a pessoa.
        if (!chosen.Any(AccessPermissions.IsModule))
        {
            errors.Add(ErrorNoModule);
        }

        if (chosen.Any(p => AccessPermissions.RequiredModule(p) is { } module && !chosen.Contains(module)))
        {
            errors.Add(ErrorMissingModule);
        }

        return errors.Count > 0
            ? new PermissionValidation([], errors)
            : new PermissionValidation(InCatalogOrder(chosen), []);
    }

    /// <summary>
    /// As permissões que valem de fato a partir do que está gravado: só as do catálogo e só as de ação cujo módulo
    /// também está gravado. É a segunda trava (a primeira é a conferência ao gravar): uma linha editada à mão no banco
    /// não concede uma ação sem o módulo dela.
    /// </summary>
    public static IReadOnlyList<string> Effective(IEnumerable<string> stored)
    {
        ArgumentNullException.ThrowIfNull(stored);

        var known = stored.Where(AccessPermissions.IsKnown).ToHashSet(StringComparer.Ordinal);
        known.RemoveWhere(p => AccessPermissions.RequiredModule(p) is { } module && !known.Contains(module));
        return InCatalogOrder(known);
    }

    private static string[] InCatalogOrder(HashSet<string> set) => [.. AccessPermissions.All.Where(set.Contains)];
}
