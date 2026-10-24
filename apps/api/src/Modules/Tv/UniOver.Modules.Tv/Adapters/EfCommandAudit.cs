using System.Globalization;
using Microsoft.EntityFrameworkCore;
using UniOver.Modules.Tv.Domain;
using UniOver.Modules.Tv.Persistence;
using UniOver.Modules.Tv.Ports;

namespace UniOver.Modules.Tv.Adapters;

/// <summary>
/// Só inclui. A retenção NÃO mora aqui: o papel da aplicação não tem <c>DELETE</c> em <c>command_audit</c> (a trilha é só
/// de inclusão no banco) e quem apaga o que passou de 30 dias é a função <c>tv.purge_audit</c>, chamada de tempos em
/// tempos pelo serviço de retenção. Também não há mais teto de linhas "da tabela": um teto assim deixaria quem inunda a
/// rota de comandos empurrar para fora, em minutos, o que a trilha existe para guardar.
/// <para>
/// O que há é um teto de VOLUME por usuário e por dia (<see cref="DailyLimitPerUser"/>): sem ele, um usuário (ou uma
/// sessão roubada) mandando comando sem parar enche o banco gratuito em poucos dias, já que a retenção só apaga depois de
/// 30. Passado o teto o comando segue funcionando; a trilha grava UMA linha de resumo (<see cref="TvCommandNames.AuditLimit"/>)
/// e para de gravar as demais desse usuário até o dia seguinte (UTC). A troca do computador da TV nunca é cortada: é rara,
/// exige passkey, e uma inundação não pode servir para esconder uma troca.
/// </para>
/// <para>
/// O teto é conferido no banco a cada gravação (e não numa contagem em memória): vale entre reinícios e entre instâncias,
/// a custo de uma contagem que para no teto. Duas gravações simultâneas na fronteira podem passar uma linha ou duas do
/// teto, e raríssimas vezes gravar duas linhas de resumo: o teto limita volume, não é uma contagem exata.
/// </para>
/// </summary>
internal sealed class EfCommandAudit(TvDbContext db) : ITvCommandAudit
{
    /// <summary>Linhas de trilha por usuário e por dia civil (UTC). Um usuário normal fica muito abaixo; passou disso, é inundação.</summary>
    public const int DailyLimitPerUser = 5000;

    public async Task RecordAsync(CommandAuditEntry entry, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(entry);

        if (await ShouldRecordAsync(entry, cancellationToken))
        {
            db.CommandAudit.Add(entry);
        }

        // Salva sempre: quem chama (a troca do computador da TV) conta com este único SaveChanges para gravar a TV junto.
        await db.SaveChangesAsync(cancellationToken);
    }

    private async Task<bool> ShouldRecordAsync(CommandAuditEntry entry, CancellationToken cancellationToken)
    {
        if (string.Equals(entry.Command, TvCommandNames.ConfigBind, StringComparison.Ordinal))
        {
            return true;
        }

        var dayStart = new DateTimeOffset(entry.OccurredAt.UtcDateTime.Date, TimeSpan.Zero);
        var dayEnd = dayStart.AddDays(1);
        var userId = entry.UserId;

        // A contagem para no teto: o custo não cresce com o que já foi gravado.
        var written = await db.CommandAudit.AsNoTracking()
            .Where(a => a.UserId == userId && a.OccurredAt >= dayStart && a.OccurredAt < dayEnd)
            .Select(a => a.Id)
            .Take(DailyLimitPerUser)
            .CountAsync(cancellationToken);
        if (written < DailyLimitPerUser)
        {
            return true;
        }

        var summarized = await db.CommandAudit.AsNoTracking()
            .AnyAsync(a => a.UserId == userId && a.Command == TvCommandNames.AuditLimit && a.OccurredAt >= dayStart && a.OccurredAt < dayEnd, cancellationToken);
        if (!summarized)
        {
            db.CommandAudit.Add(CommandAuditEntry.Create(
                userId,
                null,
                TvCommandNames.AuditLimit,
                string.Create(CultureInfo.InvariantCulture, $"limit={DailyLimitPerUser}"),
                ok: true,
                errorCode: null,
                latencyMs: null,
                new ClientInfo(entry.Ip, entry.UserAgent),
                entry.OccurredAt,
                entry.TvId));
        }

        return false;
    }
}
