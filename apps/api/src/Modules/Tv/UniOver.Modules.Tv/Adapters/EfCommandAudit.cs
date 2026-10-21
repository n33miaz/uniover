using UniOver.Modules.Tv.Domain;
using UniOver.Modules.Tv.Persistence;
using UniOver.Modules.Tv.Ports;

namespace UniOver.Modules.Tv.Adapters;

/// <summary>
/// Só inclui. A retenção NÃO mora aqui: o papel da aplicação não tem <c>DELETE</c> em <c>command_audit</c> (a trilha é só
/// de inclusão no banco) e quem apaga o que passou de 30 dias é a função <c>tv.purge_audit</c>, chamada de tempos em
/// tempos pelo serviço de retenção. A trilha também não tem mais teto de linhas: um teto deixaria quem inunda a rota de
/// comandos empurrar para fora, em minutos, o que a trilha existe para guardar.
/// </summary>
internal sealed class EfCommandAudit(TvDbContext db) : ITvCommandAudit
{
    public async Task RecordAsync(CommandAuditEntry entry, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(entry);

        db.CommandAudit.Add(entry);
        await db.SaveChangesAsync(cancellationToken);
    }
}
