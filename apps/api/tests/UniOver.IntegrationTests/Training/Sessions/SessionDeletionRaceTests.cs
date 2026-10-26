using System.Net;
using AwesomeAssertions;
using Microsoft.EntityFrameworkCore;
using UniOver.IntegrationTests.Identity;
using UniOver.IntegrationTests.Infrastructure;
using UniOver.Modules.Training.Domain.Sessions;
using static UniOver.IntegrationTests.Training.Sessions.SessionHelpers;

namespace UniOver.IntegrationTests.Training.Sessions;

/// <summary>
/// Apagar o treino (lápide) ao mesmo tempo em que uma série dele chega não pode deixar série VIVA sob treino apagado: ela
/// voltaria na leitura incremental de qualquer aparelho. Cada teste empurra os dois pedidos para dentro da janela da
/// corrida, parando um deles num comando SQL exato (<see cref="CommandBarrier"/>), nos dois sentidos de ordem.
/// </summary>
[Collection(PostgresGroup.Name)]
public sealed class SessionDeletionRaceTests(PostgresFixture postgres)
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static bool InsertsASet(string sql) =>
        sql.Contains("INSERT", StringComparison.OrdinalIgnoreCase) && sql.Contains("session_sets", StringComparison.OrdinalIgnoreCase);

    private static bool WritesTheSessionOrItsSets(string sql) =>
        SqlCommandText.StartsWithUpdate(sql) && sql.Contains("session", StringComparison.OrdinalIgnoreCase);

    [Fact]
    public async Task ASetBeingWritten_WhenTheSessionIsDeleted_EndsAsATombstoneToo()
    {
        // A série está prestes a gravar (INSERT) quando a exclusão do treino chega: ou ela espera a trava da linha do treino
        // ou, sem trava, termina antes. Nos dois casos a série tem que sair apagada junto.
        var barrier = new CommandBarrier(InsertsASet);
        await using var app = await TrainingApp.StartAsync(postgres, new TrainingAppOptions { CommandInterceptor = barrier });
        var login = await app.LoginAsync();
        var now = DateTimeOffset.UtcNow;
        var sessionId = await app.OpenSessionAsync(login, now.AddMinutes(-10));
        var setId = Guid.CreateVersion7();
        barrier.Arm();

        var set = app.PutSetAsync(login, sessionId, setId, SetBody(now, CatalogId(0)));
        await barrier.Reached.WaitAsync(CommandBarrier.Ceiling, Ct);
        var deletion = app.PutSessionAsync(login, sessionId, SessionBody(now.AddMinutes(-5), deleted: true));
        await Task.WhenAny(deletion, barrier.OtherWaitsOnLock).WaitAsync(CommandBarrier.Ceiling, Ct);
        barrier.Release();
        using var setResponse = await set.WaitAsync(CommandBarrier.Ceiling, Ct);
        using var deletionResponse = await deletion.WaitAsync(CommandBarrier.Ceiling, Ct);

        setResponse.StatusCode.Should().Be(HttpStatusCode.OK);
        deletionResponse.StatusCode.Should().Be(HttpStatusCode.OK);
        await AssertNoLiveSetUnderTheDeletedSessionAsync(app, login, sessionId, expectedSets: 1);
    }

    [Fact]
    public async Task ASetThatArrivesWhileTheSessionIsBeingDeleted_IsStoredAsATombstone()
    {
        // O sentido contrário: a exclusão do treino já leu as séries vivas e está prestes a gravar a lápide quando chega
        // uma série nova. Sem trava, essa série entra viva depois da leitura e ninguém a apaga.
        var barrier = new CommandBarrier(WritesTheSessionOrItsSets);
        await using var app = await TrainingApp.StartAsync(postgres, new TrainingAppOptions { CommandInterceptor = barrier });
        var login = await app.LoginAsync();
        var now = DateTimeOffset.UtcNow;
        var sessionId = await app.OpenSessionAsync(login, now.AddMinutes(-10));
        using (var earlier = await app.PutSetAsync(login, sessionId, Guid.CreateVersion7(), SetBody(now.AddMinutes(-8), CatalogId(0))))
        {
            earlier.StatusCode.Should().Be(HttpStatusCode.OK);
        }

        barrier.Arm();

        var deletion = app.PutSessionAsync(login, sessionId, SessionBody(now.AddMinutes(-5), deleted: true));
        await barrier.Reached.WaitAsync(CommandBarrier.Ceiling, Ct);
        var set = app.PutSetAsync(login, sessionId, Guid.CreateVersion7(), SetBody(now, CatalogId(0), position: 1));
        await Task.WhenAny(set, barrier.OtherWaitsOnLock).WaitAsync(CommandBarrier.Ceiling, Ct);
        barrier.Release();
        using var deletionResponse = await deletion.WaitAsync(CommandBarrier.Ceiling, Ct);
        using var setResponse = await set.WaitAsync(CommandBarrier.Ceiling, Ct);

        deletionResponse.StatusCode.Should().Be(HttpStatusCode.OK);
        setResponse.StatusCode.Should().Be(HttpStatusCode.OK, "a série da fila de outro aparelho não falha para sempre");
        (await TrainingApp.JsonAsync(setResponse)).GetProperty("deleted").GetBoolean().Should().BeTrue();
        await AssertNoLiveSetUnderTheDeletedSessionAsync(app, login, sessionId, expectedSets: 2);
    }

    /// <summary>O treino está apagado, nenhuma série dele está viva no banco e nenhuma volta viva na leitura incremental.</summary>
    private static async Task AssertNoLiveSetUnderTheDeletedSessionAsync(TrainingApp app, LoggedIn login, Guid sessionId, int expectedSets)
    {
        await using (var db = app.Db())
        {
            (await db.Set<Session>().SingleAsync(s => s.Id == sessionId, Ct)).IsDeleted.Should().BeTrue();
            var sets = await db.Set<SessionSet>().Where(s => s.SessionId == sessionId).ToListAsync(Ct);
            sets.Should().HaveCount(expectedSets);
            sets.Should().OnlyContain(s => s.DeletedAt != null, "série viva sob treino apagado volta na leitura incremental");
        }

        var pulled = (await app.PullAllAsync(login, "sets", limit: 50)).Rows().ToList();
        pulled.Should().HaveCount(expectedSets);
        pulled.Should().OnlyContain(row => row.GetProperty("deleted").GetBoolean());
    }
}
