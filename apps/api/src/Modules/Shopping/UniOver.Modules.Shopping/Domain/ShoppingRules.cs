namespace UniOver.Modules.Shopping.Domain;

/// <summary>Os limites que o banco também impõe (tamanho das colunas e precisão dos números).</summary>
public static class ShoppingLimits
{
    public const int Name = 120;
    public const int Section = 80;
    public const int Unit = 24;
    public const int Size = 40;
    public const int Note = 500;
    public const int Store = 120;
    public const int ReceiptKey = 200;

    /// <summary>Cabe em <c>numeric(12,3)</c>.</summary>
    public const decimal MaxQuantity = 999_999.999m;

    /// <summary>Cabe em <c>numeric(12,2)</c>.</summary>
    public const decimal MaxMoney = 9_999_999.99m;
}

/// <summary>Regras puras de validação, sem banco nem relógio.</summary>
public static class ShoppingRules
{
    /// <summary>Texto opcional: aparado; vazio vira ausente.</summary>
    public static string? Clean(string? value) => string.IsNullOrWhiteSpace(value) ? null : value.Trim();

    /// <summary>Verdadeiro se o texto (já aparado) cabe no limite.</summary>
    public static bool Fits(string? value, int max) => value is null || value.Length <= max;

    public static bool IsQuantity(decimal value) => value is > 0 and <= ShoppingLimits.MaxQuantity;

    /// <summary>Dinheiro opcional (preço, teto, total): ausente ou entre zero e o que a coluna guarda.</summary>
    public static bool IsMoney(decimal? value) => value is null or (>= 0 and <= ShoppingLimits.MaxMoney);
}
