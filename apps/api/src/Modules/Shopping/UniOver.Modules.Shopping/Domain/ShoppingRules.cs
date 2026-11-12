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
    public const int ExternalRef = 200;
    public const int PromoNote = 40;

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

    /// <summary>
    /// De dois textos do mesmo campo em registros juntados, qual fica: o que existe; havendo os dois, o primeiro na ordem
    /// dos caracteres. A escolha não depende de qual aparelho chegou antes.
    /// </summary>
    public static string? Prefer(string? first, string? second)
    {
        if (string.IsNullOrEmpty(first))
        {
            return string.IsNullOrEmpty(second) ? first : second;
        }

        return string.IsNullOrEmpty(second) || string.CompareOrdinal(first, second) <= 0 ? first : second;
    }

    /// <summary>
    /// Quando a pessoa fez a mudança, no relógio do servidor. O aparelho conta quando fez (<paramref name="at"/>) e quando
    /// enviou (<paramref name="sentAt"/>), os dois no relógio dele: a diferença entre os relógios sai da conta, então um
    /// aparelho atrasado ou adiantado não perde nem ganha por isso. Nunca fica à frente de <paramref name="now"/>; sem as
    /// duas horas (aparelho de versão anterior), vale a hora de chegada.
    /// </summary>
    public static DateTimeOffset ChangedAt(DateTimeOffset? at, DateTimeOffset? sentAt, DateTimeOffset now)
    {
        if (at is not { } told || sentAt is not { } sent)
        {
            return now;
        }

        var corrected = told + (now - sent);
        return corrected < now ? corrected : now;
    }

    /// <summary>
    /// Grava o preço informado numa linha da compra se ele for o mais recente (no empate, o maior). Tirar o preço também
    /// é informar; "sem preço" numa linha que já não tinha preço não informa nada e não toma o lugar de ninguém.
    /// </summary>
    /// <param name="promo">A promoção que anda com o preço: vale e some junto com ele (sem preço, sem promoção).</param>
    public static void Price(PurchaseItem line, decimal? unitPrice, DateTimeOffset at, Promo? promo = null)
    {
        ArgumentNullException.ThrowIfNull(line);
        if (unitPrice is null && line.UnitPrice is null)
        {
            return;
        }

        if (line.PricedAt is { } known && (at < known || (at == known && (unitPrice ?? -1) < (line.UnitPrice ?? -1))))
        {
            return;
        }

        line.UnitPrice = unitPrice;
        line.RegularPrice = unitPrice is null ? null : promo?.RegularPrice;
        line.PromoNote = unitPrice is null ? null : promo?.Note;
        line.PricedAt = at;
    }

    /// <summary>O preço normal da etiqueta e o texto da promoção ("leve 3 pague 2"), os dois opcionais.</summary>
    public sealed record Promo(decimal? RegularPrice, string? Note);
}
