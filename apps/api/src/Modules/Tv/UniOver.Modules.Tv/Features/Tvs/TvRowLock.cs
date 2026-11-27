using Microsoft.EntityFrameworkCore;
using UniOver.Modules.Tv.Domain;
using UniOver.Modules.Tv.Persistence;

namespace UniOver.Modules.Tv.Features.Tvs;

/// <summary>
/// Serializa quem muda a própria TV (trocar o computador, ajustes) com quem a remove. O bloqueio de linha do Postgres
/// vale até o commit ou o rollback da transação aberta pelo chamador e deve ser tomado ANTES de ler a TV: assim a leitura
/// já enxerga o que a outra gravação confirmou. Sem ele, a remoção lia a TV com o computador antigo, uma troca de
/// computador confirmava no meio, e a trilha permanente registrava o computador e o tipo errados para uma TV que já
/// estava ligada a outro.
/// <para>
/// O mesmo bloqueio vale para quem GRAVA dados da TV (atalhos, ícones, relatórios, TV Livre, layout, chaves). Essas
/// tabelas não têm FK para <c>tvs</c> de propósito (<c>tv_id = Guid.Empty</c> é a instalação antiga, sem linha de TV), então
/// só o bloqueio impede que uma gravação em andamento termine DEPOIS da remoção e deixe linhas órfãs. Ordem única em todo
/// o módulo: o bloqueio de filiações (só a remoção e o cadastro o tomam) vem antes da linha da TV, e quem só grava dados
/// nunca toma o de filiações; assim não há ciclo de espera.
/// </para>
/// </summary>
internal static class TvRowLock
{
    /// <summary>Se a TV não existe, não bloqueia nada: a leitura seguinte devolve nulo e o chamador trata como "não existe".</summary>
    public static Task LockAsync(TvDbContext db, Guid tvId, CancellationToken cancellationToken) =>
        db.Database.ExecuteSqlInterpolatedAsync($"""SELECT id FROM "tv"."tvs" WHERE id = {tvId} FOR UPDATE""", cancellationToken);

    /// <summary>
    /// Bloqueia a TV do agente e a devolve já lida (rastreada), na mesma consulta: o <c>FOR UPDATE</c> reavalia o filtro sobre a
    /// versão confirmada, então uma TV removida ou religada a outro computador por quem confirmou antes devolve <c>null</c>.
    /// Exige transação aberta pelo chamador.
    /// </summary>
    public static Task<ConfiguredTv?> LockByAgentAsync(TvDbContext db, string agentSlug, CancellationToken cancellationToken) =>
        db.Tvs.FromSqlInterpolated($"""SELECT * FROM "tv"."tvs" WHERE agent_slug = {agentSlug} FOR UPDATE""")
            .SingleOrDefaultAsync(cancellationToken);

    /// <summary>Como <see cref="LockAsync"/>, mas diz se a TV existe. Exige transação aberta pelo chamador.</summary>
    public static async Task<bool> TryLockAsync(TvDbContext db, Guid tvId, CancellationToken cancellationToken) =>
        (await db.Database.SqlQuery<int>($"""SELECT 1 AS "Value" FROM "tv"."tvs" WHERE id = {tvId} FOR UPDATE""")
            .ToListAsync(cancellationToken)).Count > 0;

    /// <summary>
    /// Depois do commit da troca, relê o vínculo e o aplica em memória sob o bloqueio da linha. A troca pode ter sido
    /// superada desde o commit, e nenhuma outra pode confirmar entre esta leitura e a atualização em memória.
    /// </summary>
    public static async Task ApplyToCurrentBindingAsync(TvDbContext db, Guid tvId, Action<ConfiguredTv> apply)
    {
        // A troca já está gravada: o cancelamento da requisição não pode deixar a vigia com o vínculo anterior.
        await using var transaction = await db.Database.BeginTransactionAsync(CancellationToken.None);
        var current = await db.Tvs.FromSqlInterpolated($"""SELECT * FROM "tv"."tvs" WHERE id = {tvId} FOR UPDATE""")
            .AsNoTracking().SingleOrDefaultAsync(CancellationToken.None);
        if (current is not null)
        {
            apply(current);
        }

        await transaction.CommitAsync(CancellationToken.None);
    }

    /// <summary>
    /// Roda <paramref name="write"/> numa transação com a TV bloqueada e confirma. Devolve <c>false</c>, sem gravar nada, se a
    /// TV já foi removida. Sem linha de TV (<c>Guid.Empty</c>, instalação antiga) não há remoção possível: grava direto.
    /// Nunca segure isto durante uma espera por agente: a remoção e os ajustes da TV esperariam o prazo inteiro.
    /// </summary>
    public static async Task<bool> WriteIfPresentAsync(
        TvDbContext db, Guid tvId, Func<Task> write, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(write);
        if (tvId == Guid.Empty)
        {
            await write();
            return true;
        }

        await using var transaction = await db.Database.BeginTransactionAsync(cancellationToken);
        if (!await TryLockAsync(db, tvId, cancellationToken))
        {
            return false;
        }

        await write();
        await transaction.CommitAsync(cancellationToken);
        return true;
    }
}
