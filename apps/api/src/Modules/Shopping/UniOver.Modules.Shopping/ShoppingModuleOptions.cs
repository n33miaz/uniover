using System.Text.RegularExpressions;

namespace UniOver.Modules.Shopping;

/// <summary>Tudo que é ajustável do módulo, em <c>Modules:Shopping</c>.</summary>
public sealed class ShoppingModuleOptions
{
    public const string SectionName = "Modules:Shopping";

    public EconomizeOptions Economize { get; set; } = new();

    /// <summary>Desligada, a integração não precisa de nada; ligada, endereço e chave têm de estar no formato certo.</summary>
    public static bool IsValid(ShoppingModuleOptions options) =>
        options is not null && (!options.Economize.Enabled || options.Economize.IsComplete());
}

/// <summary>
/// Leituras opcionais do Economize (<c>Modules:Shopping:Economize</c>). Desligada por padrão: sem <see cref="Enabled"/> e
/// sem chave, nenhum pedido sai do servidor.
/// </summary>
public sealed partial class EconomizeOptions
{
    public bool Enabled { get; set; }

    /// <summary>Só da configuração, nunca de quem chama; https, sem usuário, consulta ou fragmento.</summary>
    public string BaseUrl { get; set; } = string.Empty;

    /// <summary>A chave de integração emitida pelo Economize. Nunca é devolvida, registrada em log nem posta em erro.</summary>
    public string ApiKey { get; set; } = string.Empty;

    /// <summary>Ligada e com endereço e chave no formato certo: só assim um pedido pode sair.</summary>
    public bool IsActive => Enabled && IsComplete();

    internal bool IsComplete() => TryBaseUri(out _) && ApiKeyFormat().IsMatch(ApiKey ?? string.Empty);

    internal bool TryBaseUri(out Uri baseUri)
    {
        if (Uri.TryCreate(BaseUrl, UriKind.Absolute, out var parsed)
            && parsed.Scheme == Uri.UriSchemeHttps
            && string.IsNullOrEmpty(parsed.UserInfo)
            && string.IsNullOrEmpty(parsed.Query)
            && string.IsNullOrEmpty(parsed.Fragment))
        {
            baseUri = parsed;
            return true;
        }

        baseUri = null!;
        return false;
    }

    [GeneratedRegex(@"^eco_[A-Za-z0-9_-]{43}\z",RegexOptions.CultureInvariant)]
    private static partial Regex ApiKeyFormat();
}
