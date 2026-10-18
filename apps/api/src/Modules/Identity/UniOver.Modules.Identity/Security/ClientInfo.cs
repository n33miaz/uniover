using Microsoft.AspNetCore.Http;
using UniOver.Modules.Identity.Domain;
using UniOver.Modules.Identity.Persistence;

namespace UniOver.Modules.Identity.Security;

/// <summary>IP e User-Agent da requisição, entregues aos handlers pelo endpoint (o handler não toca no HttpContext).</summary>
internal sealed record ClientInfo(string? Ip, string? UserAgent)
{
    public static ClientInfo From(HttpContext http)
    {
        ArgumentNullException.ThrowIfNull(http);

        // O IP já vem corrigido pelos forwarded headers quando ligados; o User-Agent é texto do cliente e é truncado na gravação.
        return new ClientInfo(
            http.Connection.RemoteIpAddress?.ToString(),
            http.Request.Headers.UserAgent.ToString() is { Length: > 0 } agent ? agent : null);
    }
}

/// <summary>Acrescenta linhas à trilha de auditoria; quem chama confirma com o <c>SaveChanges</c> da própria operação.</summary>
internal sealed class LoginAuditWriter(IdentityDbContext db, TimeProvider time)
{
    public void Add(Guid? userId, string eventName, ClientInfo client, string? detail = null)
    {
        ArgumentNullException.ThrowIfNull(client);
        db.LoginAudit.Add(LoginAuditEntry.Create(userId, eventName, time.GetUtcNow(), client.Ip, client.UserAgent, detail));
    }
}
