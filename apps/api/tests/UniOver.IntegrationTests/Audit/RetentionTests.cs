using AwesomeAssertions;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using Npgsql;
using UniOver.BuildingBlocks.Persistence;
using UniOver.IntegrationTests.Infrastructure;
using UniOver.IntegrationTests.Messaging;
using static UniOver.IntegrationTests.Audit.AuditKit;

namespace UniOver.IntegrationTests.Audit;

/// <summary>
/// A retenção é uma função do banco, não código da aplicação: tem piso fixo dentro dela, roda com os direitos do dono e
/// só o papel da aplicação a executa. A aplicação nunca consegue apagar o recente, nem encurtar o prazo.
/// </summary>
[Collection(PostgresGroup.Name)]
public sealed class RetentionTests(PostgresFixture postgres)
{
    /// <summary>Um schema de auditoria: onde está a tabela, o piso em dias e a coluna de texto livre usada para marcar as linhas do teste.</summary>
    public sealed record AuditSchema(string Schema, string Table, int FloorDays, string MarkColumn, string InsertTemplate)
    {
        public override string ToString() => Schema;

        public string Qualified => $"{Schema}.{Table}";
    }

    // A coluna de marca é nula na tabela e livre para o teste. As linhas nascem com a idade pedida (em dias).
    private static readonly AuditSchema Identity = new(
        "identity", "login_audit", AuditRetentionPolicy.SecurityDays, "detail",
        "INSERT INTO identity.login_audit (id, user_id, event, occurred_at, detail) VALUES (gen_random_uuid(), NULL, 'login_failed', now() - make_interval(days => {0}), '{1}')");

    private static readonly AuditSchema Devices = new(
        "devices", "pairing_audit", AuditRetentionPolicy.SecurityDays, "user_agent",
        "INSERT INTO devices.pairing_audit (id, event, occurred_at, user_agent) VALUES (gen_random_uuid(), 'pairing_started', now() - make_interval(days => {0}), '{1}')");

    private static readonly AuditSchema Tv = new(
        "tv", "command_audit", AuditRetentionPolicy.CommandDays, "detail",
        "INSERT INTO tv.command_audit (id, user_id, tv_id, command, ok, occurred_at, detail) VALUES (gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 'tv.key', true, now() - make_interval(days => {0}), '{1}')");

    public static TheoryData<AuditSchema> Schemas => [Identity, Devices, Tv];

    private static Task InsertAsync(string connection, AuditSchema schema, int ageDays, string mark) =>
        ExecuteAsync(connection, string.Format(System.Globalization.CultureInfo.InvariantCulture, schema.InsertTemplate, ageDays, mark));

    private static async Task<string[]> MarksAsync(string connection, AuditSchema schema)
    {
        await using var conn = new NpgsqlConnection(connection);
        await conn.OpenAsync(Ct);
#pragma warning disable CA2100 // Nomes fixos do próprio teste, sem texto de usuário.
        await using var command = new NpgsqlCommand($"SELECT COALESCE({schema.MarkColumn}, '') FROM {schema.Qualified} ORDER BY 1", conn);
#pragma warning restore CA2100
        await using var reader = await command.ExecuteReaderAsync(Ct);
        var marks = new List<string>();
        while (await reader.ReadAsync(Ct))
        {
            marks.Add(reader.GetString(0));
        }

        return [.. marks];
    }

    private static async Task<long> PurgeAsync(string connection, AuditSchema schema, int? days)
    {
        await using var conn = new NpgsqlConnection(connection);
        await conn.OpenAsync(Ct);
#pragma warning disable CA2100 // Nome de schema fixo do próprio teste; o prazo vai como parâmetro.
        await using var command = new NpgsqlCommand($"SELECT {schema.Schema}.purge_audit(@days)", conn);
#pragma warning restore CA2100
        command.Parameters.AddWithValue("days", days is null ? DBNull.Value : (object)days.Value);
        return Convert.ToInt64(await command.ExecuteScalarAsync(Ct), System.Globalization.CultureInfo.InvariantCulture);
    }

    [Theory]
    [MemberData(nameof(Schemas))]
    public async Task NeverDeletesBelowTheFloor_NoMatterTheArgument_AndDeletesWhatIsOlder(AuditSchema schema)
    {
        var database = await MigratedDatabaseAsync(postgres);
        var floor = schema.FloorDays;

        foreach (var days in new int?[] { 0, 1, -50, null, int.MinValue })
        {
            await InsertAsync(database.OwnerConnection, schema, 1, "recente");
            await InsertAsync(database.OwnerConnection, schema, floor - 1, "quase-no-piso");
            await InsertAsync(database.OwnerConnection, schema, floor + 1, "vencida");
            await InsertAsync(database.OwnerConnection, schema, floor + 400, "antiga");

            // Pelo papel da APLICAÇÃO: é o que uma sessão roubada teria.
            var removed = await PurgeAsync(database.RuntimeConnection, schema, days);

            removed.Should().Be(2, $"argumento {days?.ToString(System.Globalization.CultureInfo.InvariantCulture) ?? "nulo"}: só as duas que passaram do piso");
            (await MarksAsync(database.OwnerConnection, schema)).Should().Equal(["quase-no-piso", "recente"], $"argumento {days}");
            await ExecuteAsync(database.OwnerConnection, $"DELETE FROM {schema.Qualified}");
        }
    }

    [Theory]
    [MemberData(nameof(Schemas))]
    public async Task AGreaterArgument_OnlyExtendsTheRetention(AuditSchema schema)
    {
        var database = await MigratedDatabaseAsync(postgres);
        var floor = schema.FloorDays;
        await InsertAsync(database.OwnerConnection, schema, floor + 1, "vencida-mas-dentro-do-prazo-maior");
        await InsertAsync(database.OwnerConnection, schema, floor + 400, "antiga");
        await InsertAsync(database.OwnerConnection, schema, 1, "recente");

        var removed = await PurgeAsync(database.RuntimeConnection, schema, floor + 100);

        removed.Should().Be(1);
        (await MarksAsync(database.OwnerConnection, schema)).Should().Equal(["recente", "vencida-mas-dentro-do-prazo-maior"]);
    }

    [Theory]
    [MemberData(nameof(Schemas))]
    public async Task AHugeArgument_IsCapped_NotAnError(AuditSchema schema)
    {
        var database = await MigratedDatabaseAsync(postgres);
        await InsertAsync(database.OwnerConnection, schema, schema.FloorDays + 400, "antiga");

        var removed = await PurgeAsync(database.RuntimeConnection, schema, int.MaxValue);

        removed.Should().Be(0);
        (await MarksAsync(database.OwnerConnection, schema)).Should().Equal(["antiga"]);
    }

    [Theory]
    [MemberData(nameof(Schemas))]
    public async Task TheFunction_IsSecurityDefiner_WithAFixedSearchPath_AndOnlyTheRuntimeRoleExecutesIt(AuditSchema schema)
    {
        var database = await MigratedDatabaseAsync(postgres);
        var signature = $"{schema.Schema}.purge_audit(integer)";

        (await ScalarAsync(database.OwnerConnection, "SELECT CASE WHEN prosecdef THEN 1 ELSE 0 END FROM pg_proc WHERE oid = @sig::regprocedure", ("sig", signature)))
            .Should().Be(1, "roda com os direitos do dono");

        await using var conn = new NpgsqlConnection(database.OwnerConnection);
        await conn.OpenAsync(Ct);
        await using var command = new NpgsqlCommand(
            "SELECT array_to_string(proconfig, ';'), pg_get_userbyid(proowner) FROM pg_proc WHERE oid = @sig::regprocedure", conn);
        command.Parameters.AddWithValue("sig", signature);
        await using var reader = await command.ExecuteReaderAsync(Ct);
        (await reader.ReadAsync(Ct)).Should().BeTrue();
        var config = reader.GetString(0);
        // O Postgres guarda a lista normalizada (aspas só onde precisa); pg_temp por último impede que um objeto temporário tome o lugar de um da função.
        config.Should().MatchRegex($"^search_path=pg_catalog, \"?{schema.Schema}\"?, pg_temp$");
        reader.GetString(1).Should().Be(PostgresFixture.OwnerRole, "a função pertence ao papel das migrations, o único com DELETE na tabela");
        await reader.CloseAsync();

        (await ScalarAsync(database.OwnerConnection, "SELECT CASE WHEN has_function_privilege('public', @sig::regprocedure, 'EXECUTE') THEN 1 ELSE 0 END", ("sig", signature)))
            .Should().Be(0, "ninguém além do papel da aplicação executa");
        (await ScalarAsync(database.OwnerConnection, "SELECT CASE WHEN has_function_privilege(@role::name, @sig::regprocedure, 'EXECUTE') THEN 1 ELSE 0 END", ("role", PostgresFixture.RuntimeRole), ("sig", signature)))
            .Should().Be(1);
    }

    [Theory]
    [MemberData(nameof(Schemas))]
    public async Task ADirectDelete_ByTheRuntimeRole_IsRefused_ButTheFunctionStillWorksForIt(AuditSchema schema)
    {
        var database = await MigratedDatabaseAsync(postgres);
        await InsertAsync(database.OwnerConnection, schema, schema.FloorDays + 5, "vencida");

        var direct = async () => await ExecuteAsync(database.RuntimeConnection, $"DELETE FROM {schema.Qualified}");
        var refused = await direct.Should().ThrowAsync<PostgresException>();
        refused.Which.SqlState.Should().Be("42501");

        (await PurgeAsync(database.RuntimeConnection, schema, schema.FloorDays)).Should().Be(1);
    }

    [Fact]
    public async Task ThePurgeService_CallsTheFunctionsThroughTheRealApplicationConnection()
    {
        var database = await MigratedDatabaseAsync(postgres);
        foreach (var schema in new[] { Identity, Devices, Tv })
        {
            await InsertAsync(database.OwnerConnection, schema, schema.FloorDays + 10, "vencida");
            await InsertAsync(database.OwnerConnection, schema, 2, "recente");
        }

        await using var app = await StartAppAsync(postgres, database);
        var service = app.Services.GetRequiredService<AuditPurgeService>();

        var results = await service.RunOnceAsync(Ct);

        results.Select(r => r.Name).Should().BeEquivalentTo("identity.purge_audit", "devices.purge_audit", "tv.purge_audit", "identity.refresh_families");
        results.Should().OnlyContain(r => r.Succeeded);
        foreach (var schema in new[] { Identity, Devices, Tv })
        {
            var marks = await MarksAsync(database.OwnerConnection, schema);

            // O Identity tem também as linhas do seed do dono; o que importa é a vencida sumir e a recente ficar.
            marks.Should().NotContain("vencida", schema.Qualified);
            marks.Should().Contain("recente", schema.Qualified);
        }

        app.Logs.Lines.Should().NotContain(l => l.Contains("ainda pode alterar ou apagar", StringComparison.Ordinal), "com a migration aplicada o papel só inclui");
    }

    [Fact]
    public async Task ThePurgeService_WarnsInTheLog_WhenTheRuntimeRoleCanStillWriteToAnAuditTable()
    {
        var database = await MigratedDatabaseAsync(postgres);

        // O que uma herança de papel (ou um GRANT à mão) faria: o papel volta a poder apagar na trilha.
        await ExecuteAsync(database.OwnerConnection, "GRANT DELETE ON tv.command_audit TO uniover_app");
        await using var app = await StartAppAsync(postgres, database);
        var service = app.Services.GetRequiredService<AuditPurgeService>();

        var results = await service.RunOnceAsync(Ct);

        results.Should().OnlyContain(r => r.Succeeded);
        app.Logs.Lines.Should().ContainSingle(l => l.Contains("ainda pode alterar ou apagar", StringComparison.Ordinal) && l.Contains("\"tv\".\"command_audit\"", StringComparison.Ordinal));
    }

    [Fact]
    public async Task ThePurgeService_ReportsAFailure_WithoutTheMessage_AndKeepsGoing()
    {
        var database = await postgres.CreateDatabaseAsync();

        // Banco sem as migrations: as funções não existem. A limpeza vira aviso, nunca derruba o serviço.
        await using var app = await IdentityApp_StartWithoutMigrationsAsync(database);
        var service = app.Services.GetRequiredService<AuditPurgeService>();

        var results = await service.RunOnceAsync(Ct);

        results.Should().HaveCount(4);
        results.Should().OnlyContain(r => !r.Succeeded && r.Error != null && !r.Error.Contains(' ', StringComparison.Ordinal));
    }

    private Task<UniOver.IntegrationTests.Identity.IdentityApp> IdentityApp_StartWithoutMigrationsAsync(TestDatabase database) =>
        UniOver.IntegrationTests.Identity.IdentityApp.StartAsync(
            postgres, new UniOver.IntegrationTests.Identity.IdentityAppOptions { Database = database, OwnerEmail = null });

    // O agendamento, sem banco: relógio falso e uma limpeza de mentira. Nada aqui dorme por um tempo fixo: o relógio só
    // anda quando o teste manda, e o teste só o manda depois de ver (pelo relógio falso) que o serviço armou a espera.
    // O BackgroundService do .NET 10 inicia o ExecuteAsync com Task.Run: ao voltar do StartAsync o temporizador ainda pode
    // não existir, e avançar o relógio nesse instante ganharia da criação dele (a rodada nunca viria, só em executor lento).

    private sealed class Probe
    {
        private int _runs;

        public bool Fail { get; init; }

        public int Runs => Volatile.Read(ref _runs);

        public AuditPurgeJob Job => new("probe", (_, _) =>
        {
            Interlocked.Increment(ref _runs);
            return Fail ? throw new InvalidOperationException("detalhe interno") : Task.FromResult(7L);
        });
    }

    private static AuditPurgeService ServiceOf(FakeTimeProvider time, Probe probe, AuditPurgeOptions options) =>
        new(new ServiceCollection().BuildServiceProvider().GetRequiredService<IServiceScopeFactory>(), [probe.Job], Options.Create(options), time, NullLogger<AuditPurgeService>.Instance);

    /// <summary>
    /// Espera uma CONDIÇÃO (nunca um tempo): consulta de poucos em poucos milissegundos, com um teto folgado para um
    /// executor lento. Estourar o teto é falha do teste, com o que se esperava.
    /// </summary>
    private static async Task WaitUntilAsync(Func<bool> condition, string expected)
    {
        var deadline = DateTimeOffset.UtcNow.AddSeconds(30);
        while (!condition() && DateTimeOffset.UtcNow < deadline)
        {
            await Task.Delay(5, Ct);
        }

        condition().Should().BeTrue($"esperava: {expected}");
    }

    /// <summary>O serviço já armou a espera de número <paramref name="count"/> (o relógio falso guarda cada temporizador criado).</summary>
    private static Task WaitForTimerAsync(FakeTimeProvider time, int count) =>
        WaitUntilAsync(() => time.CreatedTimers.Count >= count, $"o serviço armar a espera número {count}");

    private static Task WaitForRunsAsync(Probe probe, int runs) =>
        WaitUntilAsync(() => probe.Runs >= runs, $"{runs} rodada(s) do serviço");

    [Fact]
    public async Task Schedule_NothingAtStartup_FirstRunAfterTheDelay_ThenOncePerInterval()
    {
        var time = new FakeTimeProvider(new DateTimeOffset(2026, 10, 21, 12, 0, 0, TimeSpan.Zero));
        var probe = new Probe();
        using var service = ServiceOf(time, probe, new AuditPurgeOptions { FirstRunDelayMinutes = 10, IntervalHours = 24 });

        await service.StartAsync(Ct);
        await WaitForTimerAsync(time, 1);
        probe.Runs.Should().Be(0, "a partida não acorda o banco");

        // Sem temporizador vencido nada roda, então estas conferências imediatas não dependem de ritmo nenhum.
        time.Advance(TimeSpan.FromMinutes(9));
        probe.Runs.Should().Be(0);

        time.Advance(TimeSpan.FromMinutes(2));
        await WaitForRunsAsync(probe, 1);
        await WaitForTimerAsync(time, 2);

        time.Advance(TimeSpan.FromHours(23));
        probe.Runs.Should().Be(1, "dentro do intervalo não roda de novo");

        time.Advance(TimeSpan.FromHours(2));
        await WaitForRunsAsync(probe, 2);
        probe.Runs.Should().Be(2);

        await service.StopAsync(Ct);
    }

    [Fact]
    public async Task Schedule_AFailingRun_DoesNotStopTheNextOne()
    {
        var time = new FakeTimeProvider(new DateTimeOffset(2026, 10, 21, 12, 0, 0, TimeSpan.Zero));
        var probe = new Probe { Fail = true };
        using var service = ServiceOf(time, probe, new AuditPurgeOptions { FirstRunDelayMinutes = 1, IntervalHours = 1 });

        await service.StartAsync(Ct);
        await WaitForTimerAsync(time, 1);
        time.Advance(TimeSpan.FromMinutes(2));
        await WaitForRunsAsync(probe, 1);

        // A rodada que falhou não derruba o serviço: ele arma a espera seguinte e roda de novo.
        await WaitForTimerAsync(time, 2);
        time.Advance(TimeSpan.FromHours(1));
        await WaitForRunsAsync(probe, 2);

        await service.StopAsync(Ct);
    }

    [Fact]
    public void Registering_RejectsABadIdentifier_AndANonPositiveRetention()
    {
        var configuration = new Microsoft.Extensions.Configuration.ConfigurationBuilder().Build();
        var services = new ServiceCollection();

        var badSchema = () => services.AddAuditPurge<Microsoft.EntityFrameworkCore.DbContext>(configuration, "Tv", "purge_audit", 30);
        var badFunction = () => services.AddAuditPurge<Microsoft.EntityFrameworkCore.DbContext>(configuration, "tv", "x(); drop", 30);
        var badDays = () => services.AddAuditPurge<Microsoft.EntityFrameworkCore.DbContext>(configuration, "tv", "purge_audit", 0);

        badSchema.Should().Throw<ArgumentException>();
        badFunction.Should().Throw<ArgumentException>();
        badDays.Should().Throw<ArgumentOutOfRangeException>();
    }
}
