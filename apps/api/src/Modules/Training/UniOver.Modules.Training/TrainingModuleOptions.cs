using System.Net.Mail;

namespace UniOver.Modules.Training;

/// <summary>Importação opcional do wger (<c>Modules:Training:Import:Wger</c>): devagar, pouco e uma vez.</summary>
public sealed class WgerImportOptions
{
    /// <summary>Só o servidor fala com o wger; o navegador nunca (a CSP do app não permite).</summary>
    public string BaseUrl { get; set; } = "https://wger.de";

    /// <summary>Intervalo entre duas chamadas ao wger. Existe para não sobrecarregar um serviço de terceiros.</summary>
    public int DelayMs { get; set; } = 1000;

    /// <summary>Teto de exercícios lidos numa importação.</summary>
    public int MaxItems { get; set; } = 1000;

    /// <summary>Exercícios por página de leitura.</summary>
    public int PageSize { get; set; } = 50;

    /// <summary>Id do idioma português na API do wger.</summary>
    public int LanguageId { get; set; } = 7;

    public int TimeoutSeconds { get; set; } = 20;

    public TimeSpan Delay => TimeSpan.FromMilliseconds(DelayMs);
}

public sealed class ImportOptions
{
    public WgerImportOptions Wger { get; set; } = new();
}

public sealed class FoodsOptions
{
    /// <summary>Contato institucional para identificação no Open Food Facts; vazio desabilita chamadas ao OFF.</summary>
    public string OffContact { get; set; } = string.Empty;
}

/// <summary>O contato entra no User-Agent: precisa ser um endereço simples e seguro para esse cabeçalho.</summary>
internal static class OffContactRules
{
    public static bool IsValid(string? value)
    {
        if (string.IsNullOrWhiteSpace(value) || value.Length is < 3 or > 200 || value.Any(char.IsControl))
        {
            return false;
        }

        return MailAddress.TryCreate(value, out var address) && address.Address == value;
    }
}

/// <summary>Tudo que é ajustável do módulo, em <c>Modules:Training</c>.</summary>
public sealed class TrainingModuleOptions
{
    public const string SectionName = "Modules:Training";

    public string Version { get; set; } = "0.0.0";

    public ImportOptions Import { get; set; } = new();

    public FoodsOptions Foods { get; set; } = new();

    internal static bool IsValid(TrainingModuleOptions o)
    {
        var wger = o.Import.Wger;
        return Uri.TryCreate(wger.BaseUrl, UriKind.Absolute, out var uri)
            && uri.Scheme == Uri.UriSchemeHttps
            && wger.DelayMs >= 0
            && wger.MaxItems is >= 1 and <= 10_000
            && wger.PageSize is >= 1 and <= 100
            && wger.LanguageId >= 1
            && wger.TimeoutSeconds is >= 1 and <= 120
            && (string.IsNullOrWhiteSpace(o.Foods.OffContact) || OffContactRules.IsValid(o.Foods.OffContact));
    }
}
