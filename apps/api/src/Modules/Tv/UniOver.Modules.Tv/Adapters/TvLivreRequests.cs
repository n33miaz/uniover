using System.Data;
using System.Data.Common;
using System.Security.Cryptography;
using System.Text;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using UniOver.Modules.Tv.Persistence;
using UniOver.Modules.Tv.Ports;
using UniOver.SharedKernel;

namespace UniOver.Modules.Tv.Adapters;

/// <summary>
/// A vez do TV Livre por TV, valendo entre todas as instâncias da API: uma trava consultiva do PostgreSQL por TV
/// (<c>pg_try_advisory_lock</c>), tomada numa conexão própria que fica aberta durante o passo inteiro e solta no fim. Se a
/// instância cai no meio, o servidor solta a trava junto com a conexão; e se o descarte falhar em soltá-la, a volta da
/// conexão ao pool a reinicia (o Npgsql descarta o estado da sessão), então a trava nunca fica presa. Fora do PostgreSQL
/// (testes de unidade) vale a vez em memória, atrás da mesma porta.
/// </summary>
internal sealed class TvLivreRequests(IServiceScopeFactory scopes) : ITvLivreRequests
{
    private const string NpgsqlProvider = "Npgsql";

    private readonly InMemoryTvLivreRequests _local = new();

    /// <summary>A chave da trava: 64 bits derivados do id da TV (o mesmo id dá sempre a mesma chave, em qualquer instância).</summary>
    internal static long KeyOf(Guid tvId) =>
        BitConverter.ToInt64(SHA256.HashData(Encoding.UTF8.GetBytes("tv-livre:" + tvId.ToString("D"))), 0);

    public async Task<ITvLivreTicket?> TryBeginAsync(Guid tvId, CancellationToken cancellationToken)
    {
        var scope = scopes.CreateAsyncScope();
        try
        {
            var db = scope.ServiceProvider.GetRequiredService<TvDbContext>();
            if (db.Database.ProviderName?.Contains(NpgsqlProvider, StringComparison.Ordinal) != true)
            {
                await scope.DisposeAsync();
                return _local.TryBegin(tvId);
            }

            await db.Database.OpenConnectionAsync(cancellationToken);
            var connection = db.Database.GetDbConnection();
            var key = KeyOf(tvId);
            if (!await ExecuteBoolAsync(connection, "SELECT pg_try_advisory_lock(@key)", key, cancellationToken))
            {
                await db.Database.CloseConnectionAsync();
                await scope.DisposeAsync();
                return null;
            }

            return new Ticket(scope, db, connection, key, IdGenerator.NewId());
        }
#pragma warning disable CA1031 // Qualquer falha ao tomar a vez devolve o escopo (e a conexão) antes de subir.
        catch
#pragma warning restore CA1031
        {
            await scope.DisposeAsync();
            throw;
        }
    }

    private static async Task<bool> ExecuteBoolAsync(DbConnection connection, string sql, long key, CancellationToken cancellationToken)
    {
        await using var command = connection.CreateCommand();
        command.CommandText = sql;
        var parameter = command.CreateParameter();
        parameter.ParameterName = "key";
        parameter.DbType = DbType.Int64;
        parameter.Value = key;
        command.Parameters.Add(parameter);
        return await command.ExecuteScalarAsync(cancellationToken) is true;
    }

    private sealed class Ticket(AsyncServiceScope scope, TvDbContext db, DbConnection connection, long key, Guid requestId) : ITvLivreTicket
    {
        public Guid RequestId { get; } = requestId;

        public async ValueTask DisposeAsync()
        {
            try
            {
                await ExecuteBoolAsync(connection, "SELECT pg_advisory_unlock(@key)", key, CancellationToken.None);
            }
#pragma warning disable CA1031 // Soltar é melhor esforço: a conexão fechada abaixo reinicia a sessão e solta a trava de qualquer jeito.
            catch
#pragma warning restore CA1031
            {
            }
            finally
            {
                await db.Database.CloseConnectionAsync();
                await scope.DisposeAsync();
            }
        }
    }
}
