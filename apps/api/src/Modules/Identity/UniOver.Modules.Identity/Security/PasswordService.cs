using Microsoft.AspNetCore.Identity;
using UniOver.Modules.Identity.Domain;

namespace UniOver.Modules.Identity.Security;

internal enum PasswordCheck
{
    Failed,
    Success,

    /// <summary>Senha certa, mas o hash usa parâmetros antigos: vale regravar.</summary>
    SuccessRehashNeeded,
}

/// <summary>
/// Hash de senha com o PBKDF2 do Identity. Fica fora de <c>Domain/</c> porque o hasher mora em
/// <c>Microsoft.AspNetCore.Identity</c> e o domínio não referencia ASP.NET.
/// </summary>
internal sealed class PasswordService
{
    private readonly PasswordHasher<User> _hasher = new();
    private readonly Lazy<string> _dummyHash;
    private readonly User _placeholder = User.Create("placeholder@invalid", "placeholder", "x", DateTimeOffset.UnixEpoch);

    public PasswordService()
    {
        // Hash de uma senha sorteada que ninguém conhece: serve só para gastar o mesmo tempo de CPU quando o
        // e-mail não existe, sem revelar por tempo de resposta que a conta não está lá.
        _dummyHash = new Lazy<string>(() => _hasher.HashPassword(_placeholder, Guid.NewGuid().ToString("N")));
    }

    /// <summary>O PBKDF2 do Identity não usa o usuário no cálculo: o provisório só satisfaz a assinatura.</summary>
    public string Hash(string password) => _hasher.HashPassword(_placeholder, password);

    /// <summary>Com <paramref name="user"/> nulo verifica contra o hash fictício e sempre falha.</summary>
    public PasswordCheck Verify(User? user, string password)
    {
        if (user is null)
        {
            _ = _hasher.VerifyHashedPassword(_placeholder, _dummyHash.Value, password);
            return PasswordCheck.Failed;
        }

        return _hasher.VerifyHashedPassword(user, user.PasswordHash, password) switch
        {
            PasswordVerificationResult.Success => PasswordCheck.Success,
            PasswordVerificationResult.SuccessRehashNeeded => PasswordCheck.SuccessRehashNeeded,
            _ => PasswordCheck.Failed,
        };
    }
}
