using System.Text.Json.Serialization;

namespace UniOver.Modules.Identity.Features.QrLogin;

internal sealed record StartQrLoginResponse(
    string Code,
    string PollSecret,
    DateTimeOffset ExpiresAt,
    [property: JsonNumberHandling(JsonNumberHandling.Strict)] int ExpiresIn);

internal sealed record PollQrLoginRequest(string? Secret);

/// <summary>
/// <c>status</c>: <c>pending</c>, <c>approved</c> (traz o token de acesso; o refresh vai no cookie), <c>denied</c> ou
/// <c>expired</c>. Texto fixo, que o app compara.
/// </summary>
internal sealed record PollQrLoginResponse(
    string Status,
    string? AccessToken = null,
    [property: JsonNumberHandling(JsonNumberHandling.Strict)] int? ExpiresIn = null);

internal sealed record QrLoginCodeRequest(string? Code);

internal sealed record ApproveQrLoginRequest(string? Code, string? Password);

/// <summary>
/// O que o celular mostra antes de confirmar. <c>verification</c>: <c>passkey</c> (a conta tem passkey: o app confirma
/// com ela e repete), <c>password</c> (sessão antiga e sem passkey: pede a senha) ou <c>none</c> (acabou de entrar).
/// </summary>
internal sealed record QrLoginInfoResponse(
    string? UserAgent,
    bool SameNetwork,
    DateTimeOffset ExpiresAt,
    string Verification);

internal static class QrLoginStatuses
{
    public const string Pending = "pending";
    public const string Approved = "approved";
    public const string Denied = "denied";
    public const string Expired = "expired";
}

internal static class QrLoginVerifications
{
    public const string Passkey = "passkey";
    public const string Password = "password";
    public const string None = "none";
}
