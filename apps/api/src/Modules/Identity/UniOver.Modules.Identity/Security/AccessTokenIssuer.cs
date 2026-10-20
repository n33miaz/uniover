using System.Security.Claims;
using Microsoft.Extensions.Hosting;
using Microsoft.IdentityModel.JsonWebTokens;
using Microsoft.IdentityModel.Tokens;
using UniOver.BuildingBlocks.Web;

namespace UniOver.Modules.Identity.Security;

internal sealed record IssuedToken(string Value, DateTimeOffset ExpiresAt);

/// <summary>
/// Emite os JWT (acesso e bilhete de stream) com a chave de <see cref="JwtKeySet"/>. A validação mora em
/// <c>BuildingBlocks.Web</c>; aqui só se assina.
/// </summary>
internal sealed class AccessTokenIssuer(JwtKeySet keys, IHostEnvironment environment)
{
    private readonly JsonWebTokenHandler _handler = new();

    public IssuedToken Issue(Guid userId, Guid sessionId, string role, string audience, TimeSpan lifetime, DateTimeOffset now)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(audience);
        if (!AccountRoles.IsKnown(role))
        {
            throw new ArgumentException("Papel desconhecido.", nameof(role));
        }

        // Chave temporária só em desenvolvimento e teste: em produção seria uma sessão que morre a cada
        // reinício sem ninguém entender por quê. Melhor o login falhar de forma clara (o erro vai para o log).
        if (keys.IsEphemeral && !(environment.IsDevelopment() || environment.IsEnvironment("Testing")))
        {
            throw new InvalidOperationException(
                "Modules:Identity:Jwt:SigningKey ausente ou inválida: o JWT não pode ser emitido.");
        }

        var expires = now + lifetime;
        var descriptor = new SecurityTokenDescriptor
        {
            Issuer = UniOverAuth.Issuer,
            Audience = audience,
            IssuedAt = now.UtcDateTime,
            NotBefore = now.UtcDateTime,
            Expires = expires.UtcDateTime,
            SigningCredentials = keys.SigningCredentials,
            Subject = new ClaimsIdentity(
            [
                new Claim(UniOverAuth.SubjectClaim, userId.ToString()),
                new Claim(UniOverAuth.SessionClaim, sessionId.ToString()),
                new Claim(UniOverAuth.RoleClaim, role),
                new Claim(JwtRegisteredClaimNames.Jti, Guid.NewGuid().ToString("N")),
            ]),
        };

        return new IssuedToken(_handler.CreateToken(descriptor), expires);
    }
}
