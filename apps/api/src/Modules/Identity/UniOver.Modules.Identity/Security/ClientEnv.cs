namespace UniOver.Modules.Identity.Security;

/// <summary>O que o app diz de si ao abrir ou renovar a sessão: o aparelho e se roda como app instalado.</summary>
internal sealed record ClientEnvInfo(string Platform, bool Installed);

/// <summary>
/// Cabeçalho <c>X-UniOver-Client-Env: &lt;aparelho&gt;;&lt;modo&gt;</c> (por exemplo <c>iphone;standalone</c>). É só
/// informação para o dono ver em Sessões se a pessoa instalou o app: o cliente a declara sozinho, então nunca decide
/// acesso nem entra na auditoria. Qualquer coisa fora da lista fechada é ignorada, e a requisição segue como se o
/// cabeçalho não existisse (a renovação nunca falha por causa dele).
/// </summary>
internal static class ClientEnv
{
    public const string Header = "X-UniOver-Client-Env";

    public const string Standalone = "standalone";
    public const string Browser = "browser";

    private static readonly string[] Platforms = ["iphone", "ipad", "android", "pc"];

    public static ClientEnvInfo? Parse(string? value)
    {
        if (string.IsNullOrWhiteSpace(value) || value.Length > 40)
        {
            return null;
        }

        var parts = value.Split(';');
        if (parts.Length != 2)
        {
            return null;
        }

        var platform = parts[0].Trim();
        var mode = parts[1].Trim();
        if (!Platforms.Contains(platform, StringComparer.Ordinal)
            || (mode != Standalone && mode != Browser))
        {
            return null;
        }

        return new ClientEnvInfo(platform, mode == Standalone);
    }
}
