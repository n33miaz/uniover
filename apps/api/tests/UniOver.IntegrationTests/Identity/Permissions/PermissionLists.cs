namespace UniOver.IntegrationTests.Identity.Permissions;

/// <summary>
/// Listas de permissões dos testes, como campos estáticos (o analisador não aceita array constante repetido como argumento).
/// Os identificadores são escritos por extenso de propósito: o teste prova os textos gravados no banco, não as constantes do código.
/// </summary>
internal static class PermissionLists
{
    /// <summary>O que a convidada que já existe tem hoje.</summary>
    public static readonly string[] TvControlModel = ["module:tv", "tv:control", "tv:power", "tv:launch", "tv:history"];

    public static readonly string[] Training = ["module:training"];

    public static readonly string[] TvOnly = ["module:tv"];

    public static readonly string[] TvAndTraining = ["module:tv", "module:training"];

    public static readonly string[] TvAndHistory = ["module:tv", "tv:history"];

    public static readonly string[] TvControlAndTraining = ["module:tv", "tv:control", "module:training"];

    public static readonly string[] OutOfOrderWithARepeat = ["tv:power", "module:training", "module:tv", "tv:power"];

    public static readonly string[] SwapEverything = ["module:training", "tv:edit-shortcuts", "module:tv", "tv:control"];

    public static readonly string?[] WithANullItem = ["module:tv", null];

    public static readonly string[] ForgedByAnAttacker = ["tv:control", "module:tv"];

    // Listas que as regras recusam.
    public static readonly string[] ActionAlone = ["tv:control"];

    public static readonly string[] ActionWithAnotherModule = ["module:training", "tv:power"];

    public static readonly string[] UnknownItem = ["module:tv", "nao-existe"];

    public static readonly string[] UpperCaseItem = ["module:tv", "TV:CONTROL"];

    public static readonly string[] PaddedItem = ["module:tv", " tv:control"];

    public static readonly string[] Empty = [];
}
