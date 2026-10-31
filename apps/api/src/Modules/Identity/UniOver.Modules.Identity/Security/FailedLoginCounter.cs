using Microsoft.EntityFrameworkCore;
using UniOver.Modules.Identity.Domain;
using UniOver.Modules.Identity.Persistence;

namespace UniOver.Modules.Identity.Security;

/// <summary>
/// Conta a falha de senha de uma conta de forma ATÔMICA, no banco. Antes cada tentativa lia a conta, somava um em memória e
/// gravava de volta: tentativas paralelas liam o mesmo valor e contavam a menos, atrasando o bloqueio progressivo (cinco
/// chutes simultâneos podiam valer um). Agora o incremento é um único <c>UPDATE ... SET n = n + 1</c>, que o banco serializa
/// por linha, e o bloqueio sai do valor que de fato ficou lá.
/// <para>
/// O bloqueio só avança, nunca recua: o <c>UPDATE</c> que o define exige que o atual seja menor, então duas tentativas
/// concorrentes terminam com o bloqueio da maior contagem, seja qual for a ordem em que chegarem.
/// </para>
/// <para>
/// A entidade <see cref="User"/> que o chamador carregou NÃO é alterada aqui (não passa por <c>SaveChanges</c>): o salvamento
/// seguinte do chamador grava só a auditoria e não sobrescreve o contador.
/// </para>
/// </summary>
internal sealed class FailedLoginCounter(IdentityDbContext db)
{
    public async Task RegisterAsync(Guid userId, DateTimeOffset now, LockoutPolicy policy, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(policy);

        // Um único UPDATE: o banco serializa as tentativas simultâneas na mesma linha.
        var updated = await db.Users
            .Where(u => u.Id == userId)
            .ExecuteUpdateAsync(
                s => s.SetProperty(u => u.FailedLoginCount, u => u.FailedLoginCount + 1).SetProperty(u => u.LastFailedAt, now),
                cancellationToken);
        if (updated == 0)
        {
            return;
        }

        // O valor lido já inclui qualquer tentativa que tenha entrado entre o UPDATE e esta leitura, o que só deixa o bloqueio
        // mais justo: ele sempre reflete as falhas que o banco realmente tem.
        var failures = await db.Users.AsNoTracking()
            .Where(u => u.Id == userId)
            .Select(u => u.FailedLoginCount)
            .SingleAsync(cancellationToken);

        var delay = policy.DelayFor(failures);
        if (delay <= TimeSpan.Zero)
        {
            return;
        }

        var until = now + delay;
        await db.Users
            .Where(u => u.Id == userId && (u.LockoutUntil == null || u.LockoutUntil < until))
            .ExecuteUpdateAsync(s => s.SetProperty(u => u.LockoutUntil, until), cancellationToken);
    }
}
