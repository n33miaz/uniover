using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.IdentityModel.Tokens;
using UniOver.BuildingBlocks.Web;

namespace UniOver.Modules.Devices.Features.PcControl;

/// <summary>O que o bilhete do canal afirma, tudo decidido pela API na oferta (o agente nunca escreve nele).</summary>
/// <param name="Family">A sessão de login (família do refresh) que abriu o canal; sem ela a oferta não leva bilhete.</param>
/// <param name="DeviceId">O aparelho que a oferta levou ao agente (só com o escopo do PC); o mesmo que a aprovação no PC conferiu.</param>
/// <param name="ExpiresAt">O fim da vida máxima do canal (mais a janela do token): depois disso nem o agente mantém o canal.</param>
internal sealed record PcRtcTicketClaims(
    Guid SessionId,
    Guid UserId,
    Guid? Family,
    string? DeviceId,
    PcRtcScopes Scopes,
    Guid? TvId,
    string AgentSlug,
    DateTimeOffset IssuedAt,
    DateTimeOffset ExpiresAt);

/// <summary>
/// O bilhete assinado do canal direto: a prova, verificável depois de a API reiniciar, de que ELA abriu aquela sessão para aquela pessoa, com
/// aqueles escopos, neste agente. O agente só o guarda e o devolve em <c>pc.rtc.reconcile.v1</c>; nada do que ele declara além disso é
/// confiado. Formato <c>base64url(carga).base64url(HMAC-SHA256)</c>. A chave é derivada (HKDF, com um contexto próprio) da chave de assinatura
/// do JWT que a API já tem: nenhum segredo novo, e a troca de chave segue a do JWT (a anterior ainda valida). Chave temporária (só em
/// desenvolvimento) faz os bilhetes morrerem no reinício, que é o mesmo que acontece com as sessões.
/// </summary>
internal sealed class PcRtcTickets
{
    private const string Context = "uniover/pc-rtc-ticket/v1";
    private const int MacBytes = 32;

    private readonly byte[] _signing;
    private readonly IReadOnlyList<byte[]> _verifying;

    public PcRtcTickets(JwtKeySet keys)
    {
        ArgumentNullException.ThrowIfNull(keys);
        _signing = Derive(keys.SigningCredentials.Key);
        _verifying = [.. keys.ValidationKeys.Select(Derive)];
    }

    private static byte[] Derive(SecurityKey key) =>
        key is SymmetricSecurityKey symmetric
            ? HKDF.DeriveKey(HashAlgorithmName.SHA256, symmetric.Key, MacBytes, salt: null, info: Encoding.UTF8.GetBytes(Context))
            : throw new InvalidOperationException("A chave de assinatura do JWT precisa ser simétrica.");

    public string Issue(PcRtcTicketClaims claims)
    {
        ArgumentNullException.ThrowIfNull(claims);

        var payload = JsonSerializer.SerializeToUtf8Bytes(new Payload(
            1,
            claims.SessionId,
            claims.UserId,
            claims.Family,
            claims.DeviceId,
            (int)claims.Scopes,
            claims.TvId,
            claims.AgentSlug,
            claims.IssuedAt.ToUnixTimeSeconds(),
            claims.ExpiresAt.ToUnixTimeSeconds()));
        return Base64UrlEncoder.Encode(payload) + "." + Base64UrlEncoder.Encode(HMACSHA256.HashData(_signing, payload));
    }

    /// <summary>As afirmações do bilhete, ou nulo se ele foi adulterado, é de outro formato, não é de uma chave nossa ou já venceu.</summary>
    public PcRtcTicketClaims? Read(string? ticket, DateTimeOffset now)
    {
        if (string.IsNullOrEmpty(ticket) || ticket.Length > 1024)
        {
            return null;
        }

        var dot = ticket.IndexOf('.', StringComparison.Ordinal);
        if (dot <= 0 || dot == ticket.Length - 1)
        {
            return null;
        }

        byte[] payload;
        byte[] mac;
        try
        {
            payload = Base64UrlEncoder.DecodeBytes(ticket[..dot]);
            mac = Base64UrlEncoder.DecodeBytes(ticket[(dot + 1)..]);
        }
        catch (FormatException)
        {
            return null;
        }

        // Percorre todas as chaves (sem parar na primeira que casa): o tempo não diz qual era.
        var signed = false;
        foreach (var key in _verifying)
        {
            signed |= CryptographicOperations.FixedTimeEquals(HMACSHA256.HashData(key, payload), mac);
        }

        if (!signed)
        {
            return null;
        }

        try
        {
            var body = JsonSerializer.Deserialize<Payload>(payload);
            if (body is not { V: 1 } || body.Slug is null)
            {
                return null;
            }

            var claims = new PcRtcTicketClaims(
                body.Sid,
                body.Uid,
                body.Fam,
                body.Dev,
                (PcRtcScopes)body.Sc,
                body.Tv,
                body.Slug,
                DateTimeOffset.FromUnixTimeSeconds(body.Iat),
                DateTimeOffset.FromUnixTimeSeconds(body.Exp));
            return claims.ExpiresAt > now && (int)claims.Scopes is > 0 and <= 3 ? claims : null;
        }
        catch (Exception ex) when (ex is JsonException or ArgumentOutOfRangeException or OverflowException or FormatException)
        {
            // Carga assinada por nós mas fora do intervalo (instante impossível, número grande demais): nada se aproveita.
            return null;
        }
    }

    private sealed record Payload(
        [property: System.Text.Json.Serialization.JsonPropertyName("v")] int V,
        [property: System.Text.Json.Serialization.JsonPropertyName("sid")] Guid Sid,
        [property: System.Text.Json.Serialization.JsonPropertyName("uid")] Guid Uid,
        [property: System.Text.Json.Serialization.JsonPropertyName("fam")] Guid? Fam,
        [property: System.Text.Json.Serialization.JsonPropertyName("dev")] string? Dev,
        [property: System.Text.Json.Serialization.JsonPropertyName("sc")] int Sc,
        [property: System.Text.Json.Serialization.JsonPropertyName("tv")] Guid? Tv,
        [property: System.Text.Json.Serialization.JsonPropertyName("ag")] string? Slug,
        [property: System.Text.Json.Serialization.JsonPropertyName("iat")] long Iat,
        [property: System.Text.Json.Serialization.JsonPropertyName("exp")] long Exp);
}
