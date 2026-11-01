using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using UniOver.Modules.Devices.Contracts.Agents;
using UniOver.Modules.Tv.Domain;
using UniOver.Modules.Tv.Persistence;
using UniOver.Modules.Tv.Ports;

namespace UniOver.Modules.Tv.Adapters;

/// <summary>
/// Passagem transitória. Antes de a TV ser configurada pelo app, o computador que a controla vinha de uma variável de
/// ambiente do servidor (<c>Modules__Tv__AgentId</c>). O código deixou de ler essa variável; esta etapa só garante que
/// uma instalação que ainda dependia dela não perca o controle na atualização: na partida, se NENHUMA TV foi salva e a
/// variável ainda existe, a TV padrão é criada a partir dela, uma única vez. Com qualquer TV salva (o normal) não faz
/// nada, e sem a variável também não. Depois de confirmar a TV em Sistema, a variável pode ser apagada do servidor; esta
/// classe sai numa versão seguinte.
/// </summary>
internal sealed partial class LegacyAgentImport(
    IConfiguration configuration, IServiceScopeFactory scopes, TimeProvider time, ILogger<LegacyAgentImport> logger)
    : IHostedService
{
    public const string LegacyKey = "Modules:Tv:AgentId";

    public async Task StartAsync(CancellationToken cancellationToken)
    {
        var slug = configuration[LegacyKey]?.Trim();
        if (string.IsNullOrEmpty(slug))
        {
            return;
        }

        try
        {
            await ImportAsync(slug, cancellationToken);
        }
#pragma warning disable CA1031 // A API não pode deixar de subir por uma passagem que só ajuda instalações antigas.
        catch (Exception ex) when (ex is not OperationCanceledException)
#pragma warning restore CA1031
        {
            LogFailed(ex.GetType().Name);
        }
    }

    public Task StopAsync(CancellationToken cancellationToken) => Task.CompletedTask;

    private async Task ImportAsync(string slug, CancellationToken cancellationToken)
    {
        await using var scope = scopes.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<TvDbContext>();
        if (await db.Tvs.AnyAsync(cancellationToken))
        {
            return;
        }

        var listing = await scope.ServiceProvider.GetRequiredService<IAgentDirectory>().FindAsync(slug, cancellationToken);
        if (listing is null || listing.Revoked)
        {
            LogSkipped();
            return;
        }

        // Sem conta responsável: a linha é do sistema, e o administrador a renomeia ou troca em Sistema.
        db.Tvs.Add(ConfiguredTv.CreateDefault(null, listing.Slug, Guid.Empty, time.GetUtcNow()));
        try
        {
            await db.SaveChangesAsync(cancellationToken);
        }
        catch (DbUpdateException)
        {
            // Duas instâncias subindo juntas: os índices únicos deixam passar só a primeira. A outra não cria nada; se a
            // recusa tem outra causa (nenhuma TV existe agora), o erro segue e vira o aviso de falha da partida.
            if (!await AnotherInstanceSavedAsync(cancellationToken))
            {
                throw;
            }

            LogRaced();
            return;
        }

        // O resolvedor guarda a resposta por alguns segundos: sem isto, /config diria "nenhum" logo depois da importação.
        scope.ServiceProvider.GetRequiredService<ITvAgentResolver>().Invalidate();
        LogImported();
    }

    /// <summary>Relê o banco num escopo novo: o contexto da tentativa que falhou ainda guarda a linha recusada.</summary>
    private async Task<bool> AnotherInstanceSavedAsync(CancellationToken cancellationToken)
    {
        await using var scope = scopes.CreateAsyncScope();
        return await scope.ServiceProvider.GetRequiredService<TvDbContext>().Tvs.AnyAsync(cancellationToken);
    }

    [LoggerMessage(Level = LogLevel.Information, Message = "A TV padrão já foi criada por outra instância; nada a fazer.")]
    private partial void LogRaced();

    [LoggerMessage(Level = LogLevel.Information, Message = "TV padrão criada a partir da variável de ambiente antiga. Confirme a TV em Sistema e apague a variável do servidor.")]
    private partial void LogImported();

    [LoggerMessage(Level = LogLevel.Warning, Message = "A variável de ambiente antiga da TV aponta um computador que não está pareado; nada foi criado.")]
    private partial void LogSkipped();

    [LoggerMessage(Level = LogLevel.Warning, Message = "Não foi possível criar a TV a partir da variável de ambiente antiga ({ErrorType}).")]
    private partial void LogFailed(string errorType);
}
