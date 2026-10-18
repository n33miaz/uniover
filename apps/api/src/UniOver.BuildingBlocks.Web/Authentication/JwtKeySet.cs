using System.Security.Cryptography;
using Microsoft.Extensions.Logging;
using Microsoft.IdentityModel.Tokens;

namespace UniOver.BuildingBlocks.Web;

/// <summary>Chaves de assinatura lidas de <c>Modules:Identity:Jwt</c> (base64, só por variável de ambiente).</summary>
public sealed class JwtKeyOptions
{
    /// <summary>Chave atual (HS256), com 32 bytes ou mais em base64.</summary>
    public string? SigningKey { get; set; }

    /// <summary>Chave anterior: só valida, nunca assina; permite trocar a chave sem derrubar as sessões.</summary>
    public string? PreviousSigningKey { get; set; }
}

/// <summary>
/// A chave que assina e as que validam. Cada chave carrega um <c>kid</c> derivado do próprio conteúdo (sem expor
/// a chave), para o validador escolher a certa durante uma troca.
/// </summary>
public sealed partial class JwtKeySet
{
    public const int MinimumKeyBytes = 32;

    private JwtKeySet(SymmetricSecurityKey current, IReadOnlyList<SecurityKey> validationKeys, bool isEphemeral)
    {
        SigningCredentials = new SigningCredentials(current, SecurityAlgorithms.HmacSha256);
        ValidationKeys = validationKeys;
        IsEphemeral = isEphemeral;
    }

    public SigningCredentials SigningCredentials { get; }

    public IReadOnlyList<SecurityKey> ValidationKeys { get; }

    /// <summary>
    /// Chave sorteada na partida porque a configurada falta ou é inválida. Os tokens morrem a cada reinício;
    /// fora de Development/Testing o emissor se recusa a usá-la.
    /// </summary>
    public bool IsEphemeral { get; }

    [LoggerMessage(Level = LogLevel.Error, Message = "Chave de assinatura do JWT ausente ou inválida (Modules:Identity:Jwt:SigningKey, base64 com 32 bytes ou mais). Usando uma chave temporária: as sessões não sobrevivem a reinício.")]
    private static partial void LogEphemeral(ILogger logger);

    [LoggerMessage(Level = LogLevel.Error, Message = "Modules:Identity:Jwt:PreviousSigningKey é inválida (base64 com 32 bytes ou mais) e foi ignorada.")]
    private static partial void LogPreviousIgnored(ILogger logger);

    /// <summary>
    /// Nunca lança por configuração ruim: esta construção acontece na primeira autenticação e um erro aqui
    /// derrubaria todas as rotas, inclusive <c>/health/live</c>.
    /// </summary>
    public static JwtKeySet Create(JwtKeyOptions options, ILogger logger)
    {
        ArgumentNullException.ThrowIfNull(options);
        ArgumentNullException.ThrowIfNull(logger);

        var ephemeral = false;
        var currentBytes = Decode(options.SigningKey);
        if (currentBytes is null)
        {
            LogEphemeral(logger);
            currentBytes = RandomNumberGenerator.GetBytes(MinimumKeyBytes);
            ephemeral = true;
        }

        var current = ToKey(currentBytes);
        var keys = new List<SecurityKey> { current };

        if (!string.IsNullOrWhiteSpace(options.PreviousSigningKey))
        {
            var previousBytes = Decode(options.PreviousSigningKey);
            if (previousBytes is null)
            {
                LogPreviousIgnored(logger);
            }
            else
            {
                keys.Add(ToKey(previousBytes));
            }
        }

        return new JwtKeySet(current, keys, ephemeral);
    }

    private static byte[]? Decode(string? value)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            return null;
        }

        var text = value.Trim();
        var buffer = new byte[text.Length];
        if (!Convert.TryFromBase64String(text, buffer, out var written) || written < MinimumKeyBytes)
        {
            return null;
        }

        return buffer.AsSpan(0, written).ToArray();
    }

    private static SymmetricSecurityKey ToKey(byte[] bytes) =>
        new(bytes) { KeyId = Base64UrlEncoder.Encode(SHA256.HashData(bytes))[..8] };
}
