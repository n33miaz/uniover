using System.Net;
using AwesomeAssertions;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using UniOver.IntegrationTests.Infrastructure;
using UniOver.Modules.Tv.Adapters;
using UniOver.Modules.Tv.Domain;
using UniOver.Modules.Tv.Ports;

namespace UniOver.IntegrationTests.Tv;

/// <summary>
/// A trilha dos comandos da TV é gravada por uma fila, fora do caminho da resposta: segurar "volume +" não pode esperar o
/// banco (que no plano gratuito pode estar dormindo) a cada tecla.
/// </summary>
[Collection(PostgresGroup.Name)]
public sealed class CommandAuditQueueTests(PostgresFixture postgres)
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private sealed class Gate
    {
        public TaskCompletionSource Open { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);

        public int Written;
    }

    /// <summary>Grava só depois que o teste abre o portão: um banco que demora para acordar.</summary>
    private sealed class GatedAudit(Gate gate) : ITvCommandAudit
    {
        public async Task RecordAsync(CommandAuditEntry entry, CancellationToken cancellationToken)
        {
            await gate.Open.Task.WaitAsync(cancellationToken);
            Interlocked.Increment(ref gate.Written);
        }
    }

    private sealed class SecretFailingAudit : ITvCommandAudit
    {
        public Task RecordAsync(CommandAuditEntry entry, CancellationToken cancellationToken) =>
            throw new InvalidOperationException("Host=ep-segredo.neon.tech;Password=senha-do-banco");
    }

    [Fact]
    public async Task TheCommandAnswersWithoutWaitingForTheAuditToBeWritten()
    {
        var gate = new Gate();
        await using var app = await TvApp.StartAsync(postgres, new TvAppOptions
        {
            ConfigureServices = services =>
            {
                services.RemoveAll<ITvCommandAudit>();
                services.AddSingleton(gate);
                services.AddScoped<ITvCommandAudit, GatedAudit>();
            },
        });
        app.AuditDrain.Enabled = false;
        app.PassReconnectGrace();

        // O portão está fechado: se a resposta esperasse a gravação, o pedido não voltaria dentro do prazo.
        using var response = await app.PostAsync("/api/v1/tv/keys", new { key = "VOLUME_UP" }).WaitAsync(TimeSpan.FromSeconds(10), Ct);

        response.StatusCode.Should().Be(HttpStatusCode.ServiceUnavailable);
        gate.Written.Should().Be(0);

        gate.Open.SetResult();
        await app.Services.GetRequiredService<TvAuditQueue>().DrainAsync(TimeSpan.FromSeconds(20), Ct);
        gate.Written.Should().Be(1, "a linha é gravada depois, pelo gravador");
    }

    [Fact]
    public async Task ABurstOfCommands_IsAllRecorded_AfterTheQueueDrains()
    {
        await using var app = await TvApp.StartAsync(postgres);
        app.AuditDrain.Enabled = false;
        app.PassReconnectGrace();

        for (var i = 0; i < 40; i++)
        {
            using var response = await app.PostAsync("/api/v1/tv/keys", new { key = "VOLUME_UP" });
            response.StatusCode.Should().Be(HttpStatusCode.ServiceUnavailable);
        }

        var queue = app.Services.GetRequiredService<TvAuditQueue>();
        await queue.DrainAsync(TimeSpan.FromSeconds(30), Ct);

        await using var db = app.Db();
        (await db.CommandAudit.CountAsync(a => a.Command == "tv.key", Ct)).Should().Be(40);
        queue.Dropped.Should().Be(0);
    }

    [Fact]
    public async Task AWriteFailure_NeverBreaksTheCommand_AndTheLogCarriesOnlyTheErrorType()
    {
        await using var app = await TvApp.StartAsync(postgres, new TvAppOptions
        {
            ConfigureServices = services =>
            {
                services.RemoveAll<ITvCommandAudit>();
                services.AddScoped<ITvCommandAudit, SecretFailingAudit>();
            },
        });
        app.PassReconnectGrace();

        using var response = await app.PostAsync("/api/v1/tv/keys", new { key = "HOME" });

        response.StatusCode.Should().Be(HttpStatusCode.ServiceUnavailable, "o comando segue o caminho normal");
        var logs = string.Join('\n', app.Logs.Lines);
        logs.Should().Contain("Falha ao gravar a auditoria do comando tv.key (InvalidOperationException");
        logs.Should().NotContain("ep-segredo").And.NotContain("senha-do-banco");
    }
}
