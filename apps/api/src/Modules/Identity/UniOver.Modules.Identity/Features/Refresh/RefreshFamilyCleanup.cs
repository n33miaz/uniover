using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using UniOver.BuildingBlocks.Persistence;
using UniOver.Modules.Identity.Persistence;

namespace UniOver.Modules.Identity.Features.Refresh;

/// <summary>
/// Limpeza das famílias de refresh que já não servem para nada. A tabela ganha uma linha por rotação (a cada renovação,
/// de poucos em poucos minutos por sessão aberta) e nada a esvaziava.
/// <para>
/// Só se apaga a família INTEIRA, nunca um token solto: o token já usado de uma família viva é a prova do reuso (apresentá-lo
/// de novo revoga a família e entra na trilha); apagá-lo desarmaria a regra estrita do refresh. Uma família está morta,
/// e portanto descartável, quando (a) nenhum token dela pode mais ser aceito porque o último venceu (o teto absoluto de
/// 90 dias e a janela de 14 dias fazem isso), ou (b) todos os tokens foram revogados (logout, reuso, convidado ou sessão
/// revogados). Em ambos os casos espera-se <see cref="DeadFamilyRetention"/> antes de apagar, para que uma tentativa tardia
/// com um token velho ainda seja reconhecida (e auditada como reuso) por alguns dias.
/// </para>
/// <para>Roda no despertar diário do serviço de retenção (nenhum relógio novo: o banco gratuito só acorda uma vez por dia por isso).</para>
/// </summary>
internal static class RefreshFamilyCleanup
{
    public const string JobName = "identity.refresh_families";

    /// <summary>Quanto tempo uma família morta continua guardada (a prova do reuso vale por mais alguns dias).</summary>
    public static readonly TimeSpan DeadFamilyRetention = TimeSpan.FromDays(7);

    /// <summary>Apaga as famílias mortas; devolve quantos tokens (linhas) saíram.</summary>
    public static async Task<long> RunAsync(IdentityDbContext db, TimeProvider time, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(db);
        ArgumentNullException.ThrowIfNull(time);

        var cutoff = time.GetUtcNow() - DeadFamilyRetention;

        // Uma consulta só, por família: o agrupamento usa o índice (family_id, created_at) e o DELETE leva a família inteira
        // de uma vez, então nenhuma família fica pela metade nem perde só o token que prova o reuso.
        return await db.Database.ExecuteSqlAsync(
            $"""
            DELETE FROM identity.refresh_tokens
            WHERE family_id IN (
                SELECT family_id FROM identity.refresh_tokens
                GROUP BY family_id
                HAVING MAX(expires_at) < {cutoff}
                    OR (BOOL_AND(revoked_at IS NOT NULL) AND MAX(revoked_at) < {cutoff}))
            """,
            cancellationToken);
    }
}

internal static class RefreshFamilyCleanupRegistration
{
    /// <summary>Entra na lista de trabalhos do serviço de retenção que já existe (o mesmo despertar diário).</summary>
    public static IServiceCollection AddRefreshFamilyCleanup(this IServiceCollection services)
    {
        ArgumentNullException.ThrowIfNull(services);

        services.AddSingleton(new AuditPurgeJob(
            RefreshFamilyCleanup.JobName,
            (provider, cancellationToken) => RefreshFamilyCleanup.RunAsync(
                provider.GetRequiredService<IdentityDbContext>(),
                provider.GetRequiredService<TimeProvider>(),
                cancellationToken)));
        return services;
    }
}
