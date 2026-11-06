using System.Net;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using AwesomeAssertions;
using System.Data.Common;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Diagnostics;
using UniOver.IntegrationTests.Devices.Pairing;
using UniOver.IntegrationTests.Devices.Transport;
using UniOver.IntegrationTests.Infrastructure;
using UniOver.Modules.Devices.Domain;

namespace UniOver.IntegrationTests.Devices.Beacons;

/// <summary>
/// A baliza de partida do agente e o registro do handshake recusado: rota anônima que responde sempre 204, uma linha por
/// agente, limites por IP e por agente, e a leitura só pelo dono. Host real, Postgres real e relógio falso.
/// </summary>
[Collection(PostgresGroup.Name)]
public sealed class AgentBeaconTests(PostgresFixture postgres)
{
    private const string ReadUrl = "/api/v1/devices/agents/beacons";
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static string Body(string stage = "bootstrap", string code = "ok", string? detail = null) =>
        new JsonObject
        {
            ["v"] = 1,
            ["stage"] = stage,
            ["code"] = code,
            ["ver"] = "0.42.10",
            ["os"] = "windows",
            ["n"] = 2,
            ["detail"] = detail,
        }.ToJsonString();

    private static async Task<HttpResponseMessage> PostAsync(TransportApp app, string slug, string json)
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, $"/api/v1/devices/agents/{slug}/beacon")
        {
            Content = new StringContent(json, Encoding.UTF8, "application/json"),
        };
        return await app.App.Client.SendAsync(request, Ct);
    }

    private static async Task<AgentBeacon?> RowAsync(TransportApp app, Guid agentId)
    {
        await using var db = app.App.Db();
        return await db.AgentBeacons.AsNoTracking().SingleOrDefaultAsync(b => b.AgentId == agentId, Ct);
    }

    private static async Task<int> RowCountAsync(TransportApp app)
    {
        await using var db = app.App.Db();
        return await db.AgentBeacons.CountAsync(Ct);
    }

    private static async Task<AgentBeacon> WaitForRowAsync(TransportApp app, Guid agentId, Func<AgentBeacon, bool> ready, string what)
    {
        AgentBeacon? row = null;
        await TransportApp.WaitUntilAsync(async () => (row = await RowAsync(app, agentId)) is { } found && ready(found), what);
        return row!;
    }

    [Fact]
    public async Task ABeaconIsAcceptedWith204_AndOneRowIsKept()
    {
        await using var app = await TransportApp.StartAsync(postgres);

        using var response = await PostAsync(app, app.Agent.Slug, Body("child_spawn", "crash_loop", "Saiu com codigo 3"));

        response.StatusCode.Should().Be(HttpStatusCode.NoContent);
        (await response.Content.ReadAsStringAsync(Ct)).Should().BeEmpty();
        var row = (await RowAsync(app, app.Agent.Id))!;
        row.LastStage.Should().Be("child_spawn");
        row.LastCode.Should().Be("crash_loop");
        row.Version.Should().Be("0.42.10");
        row.Os.Should().Be("windows");
        row.Count.Should().Be(1);
        row.Verified.Should().BeFalse();
        row.LastAt.Should().Be(app.App.Time.GetUtcNow());
        row.FirstFailAt.Should().Be(app.App.Time.GetUtcNow());
    }

    [Fact]
    public async Task AnUnknownSlug_GetsTheSame204_AndNothingIsWritten()
    {
        await using var app = await TransportApp.StartAsync(postgres);
        var before = await app.DatabaseFingerprintAsync();

        using var known = await PostAsync(app, app.Agent.Slug, Body());
        using var unknown = await PostAsync(app, "nao-existe", Body());
        using var badShape = await PostAsync(app, "X", Body());

        // Mesma resposta, mesmos cabeçalhos de status e corpo vazio: nada denuncia se o slug existe.
        known.StatusCode.Should().Be(HttpStatusCode.NoContent);
        unknown.StatusCode.Should().Be(HttpStatusCode.NoContent);
        badShape.StatusCode.Should().Be(HttpStatusCode.NoContent);
        (await unknown.Content.ReadAsStringAsync(Ct)).Should().Be(await known.Content.ReadAsStringAsync(Ct));
        (await RowCountAsync(app)).Should().Be(1);

        var afterKnownOnly = await app.DatabaseFingerprintAsync();
        afterKnownOnly.Should().NotBe(before);
        using var again = await PostAsync(app, "nao-existe", Body("supervisor", "no_config"));
        again.StatusCode.Should().Be(HttpStatusCode.NoContent);
        (await app.DatabaseFingerprintAsync()).Should().Be(afterKnownOnly);
    }

    [Theory]
    [InlineData("isto não é json")]
    [InlineData("")]
    [InlineData("[]")]
    [InlineData("{\"stage\":\"bootstrap\"}")]
    [InlineData("{\"stage\":\"Bootstrap!\",\"code\":\"ok\"}")]
    public async Task AMalformedBody_Returns204_AndWritesNothing(string json)
    {
        await using var app = await TransportApp.StartAsync(postgres);
        var before = await app.DatabaseFingerprintAsync();

        using var response = await PostAsync(app, app.Agent.Slug, json);

        response.StatusCode.Should().Be(HttpStatusCode.NoContent);
        (await app.DatabaseFingerprintAsync()).Should().Be(before);
    }

    [Fact]
    public async Task ABodyOverTheCap_IsCutAtTheDoor_AndWritesNothing()
    {
        await using var app = await TransportApp.StartAsync(postgres);
        var before = await app.DatabaseFingerprintAsync();

        // O corpo declarado maior que 512 bytes é recusado na entrada, sem ser lido (413 não diz nada sobre o slug).
        using var declared = await PostAsync(app, app.Agent.Slug, Body(detail: new string('a', 700)));
        declared.StatusCode.Should().Be(HttpStatusCode.RequestEntityTooLarge);

        // Sem tamanho declarado (chunked), o leitor corta ao passar do teto; a rota segue respondendo 204.
        using var request = new HttpRequestMessage(HttpMethod.Post, $"/api/v1/devices/agents/{app.Agent.Slug}/beacon")
        {
            Content = new StreamContent(new NoLengthStream(Encoding.UTF8.GetBytes(Body(detail: new string('a', 700))))),
        };
        request.Content.Headers.ContentType = new System.Net.Http.Headers.MediaTypeHeaderValue("application/json");
        using var chunked = await app.App.Client.SendAsync(request, Ct);
        chunked.StatusCode.Should().BeOneOf(HttpStatusCode.NoContent, HttpStatusCode.RequestEntityTooLarge);

        (await app.DatabaseFingerprintAsync()).Should().Be(before);
    }

    /// <summary>Fluxo sem tamanho conhecido: o HttpClient manda o corpo em pedaços (chunked).</summary>
    private sealed class NoLengthStream(byte[] data) : Stream
    {
        private readonly MemoryStream _inner = new(data);

        public override bool CanRead => true;

        public override bool CanSeek => false;

        public override bool CanWrite => false;

        public override long Length => throw new NotSupportedException();

        public override long Position
        {
            get => throw new NotSupportedException();
            set => throw new NotSupportedException();
        }

        public override void Flush()
        {
        }

        public override int Read(byte[] buffer, int offset, int count) => _inner.Read(buffer, offset, count);

        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();

        public override void SetLength(long value) => throw new NotSupportedException();

        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
    }

    [Fact]
    public async Task AFreeTextDetail_IsAcceptedAndIgnored_NeverStored()
    {
        await using var app = await TransportApp.StartAsync(postgres);

        using var response = await PostAsync(app, app.Agent.Slug, Body(detail: "perfil joao silva maquina ANA-PC"));

        response.StatusCode.Should().Be(HttpStatusCode.NoContent);
        (await RowAsync(app, app.Agent.Id))!.LastStage.Should().Be("bootstrap");
        await using var db = app.App.Db();
        (await db.Database.SqlQueryRaw<string>("SELECT column_name AS \"Value\" FROM information_schema.columns WHERE table_name = 'agent_beacons'")
            .ToListAsync(Ct)).Should().NotContain("last_detail");
    }

    [Fact]
    public async Task TheSameStageInsideFiveMinutesIsDiscarded_AndAChangeIsKept()
    {
        await using var app = await TransportApp.StartAsync(postgres);
        var first = app.App.Time.GetUtcNow();
        await PostAsync(app, app.Agent.Slug, Body("supervisor", "no_config"));

        app.App.Time.Advance(TimeSpan.FromMinutes(4));
        await PostAsync(app, app.Agent.Slug, Body("supervisor", "no_config"));
        var repeated = (await RowAsync(app, app.Agent.Id))!;
        repeated.Count.Should().Be(1);
        repeated.LastAt.Should().Be(first);

        // Outra etapa entra na hora; a falha segue contada desde a primeira.
        await PostAsync(app, app.Agent.Slug, Body("child_spawn", "crash_loop"));
        var changed = (await RowAsync(app, app.Agent.Id))!;
        changed.Count.Should().Be(2);
        changed.LastStage.Should().Be("child_spawn");
        changed.FirstFailAt.Should().Be(first);

        // Passada a janela, até a repetição volta a valer.
        app.App.Time.Advance(TimeSpan.FromMinutes(6));
        await PostAsync(app, app.Agent.Slug, Body("child_spawn", "crash_loop"));
        (await RowAsync(app, app.Agent.Id))!.Count.Should().Be(3);

        // Um ok limpa o começo da falha.
        await PostAsync(app, app.Agent.Slug, Body("hello_sent", "ok"));
        (await RowAsync(app, app.Agent.Id))!.FirstFailAt.Should().BeNull();
        (await RowCountAsync(app)).Should().Be(1);
    }

    [Fact]
    public async Task ABeacon_NeverChangesThePresence()
    {
        await using var app = await TransportApp.StartAsync(postgres);

        await PostAsync(app, app.Agent.Slug, Body("hello_sent", "ok"));

        app.Presence.Get(app.Agent.Slug)?.Connected.Should().NotBe(true);
        await using var db = app.App.Db();
        (await db.AgentPresenceSnapshots.CountAsync(Ct)).Should().Be(0);
    }

    [Fact]
    public async Task ARevokedAgentsBeacon_IsDropped()
    {
        await using var app = await TransportApp.StartAsync(postgres);
        using var revoke = await app.App.RevokeRawAsync(app.Login, app.Agent.Id, "teste");
        revoke.StatusCode.Should().Be(HttpStatusCode.OK);

        using var response = await PostAsync(app, app.Agent.Slug, Body());

        response.StatusCode.Should().Be(HttpStatusCode.NoContent);
        (await RowCountAsync(app)).Should().Be(0);
    }

    [Fact]
    public async Task PerAgentLimit_DropsTheExcessSilently()
    {
        await using var app = await TransportApp.StartAsync(postgres);

        // Doze etapas diferentes passam; a 13a e descartada, mas a resposta continua 204.
        for (var i = 0; i < 14; i++)
        {
            using var response = await PostAsync(app, app.Agent.Slug, Body($"stage_{(char)('a' + i)}x"));
            response.StatusCode.Should().Be(HttpStatusCode.NoContent);
        }

        (await RowAsync(app, app.Agent.Id))!.Count.Should().Be(12);

        app.App.Time.Advance(TimeSpan.FromMinutes(1));
        await PostAsync(app, app.Agent.Slug, Body("stage_after"));
        (await RowAsync(app, app.Agent.Id))!.Count.Should().Be(13);
    }

    [Fact]
    public async Task PerIpLimit_AnswersWith429_AndNothingAboutTheSlug()
    {
        await using var app = await TransportApp.StartAsync(postgres, new DevicesAppOptions { BeaconPermitted = 3 });

        for (var i = 0; i < 3; i++)
        {
            using var accepted = await PostAsync(app, "nao-existe", Body($"stage_{(char)('a' + i)}x"));
            accepted.StatusCode.Should().Be(HttpStatusCode.NoContent);
        }

        using var known = await PostAsync(app, app.Agent.Slug, Body());
        using var unknown = await PostAsync(app, "nao-existe", Body());
        known.StatusCode.Should().Be(HttpStatusCode.TooManyRequests);
        unknown.StatusCode.Should().Be(HttpStatusCode.TooManyRequests);
        known.Headers.Contains("Retry-After").Should().BeTrue();
    }

    // ---- handshake recusado ----

    private static async Task<AgentBeacon> WaitForRejectionAsync(TransportApp app, string reason) =>
        await WaitForRowAsync(app, app.Agent.Id, row => row.LastRejectReason == reason, $"recusa {reason} anotada");

    [Fact]
    public async Task ARevokedToken_WritesNothing_AndNeverShowsInTheLogs()
    {
        await using var app = await TransportApp.StartAsync(postgres);
        var other = await app.PairAnotherAsync("Outro PC");
        using var revoke = await app.App.RevokeRawAsync(app.Login, app.Agent.Id, "teste");
        revoke.StatusCode.Should().Be(HttpStatusCode.OK);
        var before = await app.DatabaseFingerprintAsync();

        // O token revogado no caminho dele e no caminho de outro agente ativo: nenhum dos dois ganha anotação.
        (await app.HandshakeStatusAsync(app.Agent.Slug, app.Agent.Token)).Should().Be(HttpStatusCode.Forbidden);
        (await app.HandshakeStatusAsync(other.Slug, app.Agent.Token)).Should().Be(HttpStatusCode.Forbidden);
        // A anotação é aguardada dentro da própria recusa: quando a resposta chega, ela já terminou (ou foi descartada). Sem espera.

        (await app.DatabaseFingerprintAsync()).Should().Be(before);
        app.App.Logs.Lines.Should().NotContain(line => line.Contains(app.Agent.Token, StringComparison.Ordinal));
    }

    [Fact]
    public async Task AnInvalidToken_IsRecordedOncePerMinute_AndNeverInTheLogs()
    {
        await using var app = await TransportApp.StartAsync(postgres);
        var stranger = DeviceSecrets.NewDeviceToken().Token;
        var first = app.App.Time.GetUtcNow();

        (await app.HandshakeStatusAsync(app.Agent.Slug, stranger)).Should().Be(HttpStatusCode.Unauthorized);
        await WaitForRejectionAsync(app, "invalid_token");

        // Uma anotação por minuto e por agente: a seguinte só entra depois do intervalo.
        app.App.Time.Advance(TimeSpan.FromSeconds(30));
        (await app.HandshakeStatusAsync(app.Agent.Slug, DeviceSecrets.NewDeviceToken().Token)).Should().Be(HttpStatusCode.Unauthorized);
        (await RowAsync(app, app.Agent.Id))!.LastRejectedAt.Should().Be(first);

        app.App.Time.Advance(TimeSpan.FromSeconds(30));
        (await app.HandshakeStatusAsync(app.Agent.Slug, DeviceSecrets.NewDeviceToken().Token)).Should().Be(HttpStatusCode.Unauthorized);
        await TransportApp.WaitUntilAsync(
            async () => (await RowAsync(app, app.Agent.Id))!.LastRejectedAt == first.AddMinutes(1), "segunda recusa anotada");
        app.App.Logs.Lines.Should().NotContain(line => line.Contains(stranger, StringComparison.Ordinal));
    }

    [Theory]
    [InlineData("uo_dev_x")]
    [InlineData("uo_dev_")]
    [InlineData("uo_dev_!!!!notbase64!!!!")]
    [InlineData("Basic")]
    public async Task AMalformedToken_CostsNoDatabaseQuery_AndWritesNothing(string bearer)
    {
        var counter = new SlugAndBeaconQueryCounter();
        await using var app = await TransportApp.StartAsync(postgres, new DevicesAppOptions { CommandInterceptor = counter });
        var before = await app.DatabaseFingerprintAsync();
        var queries = counter.Count;

        for (var i = 0; i < 40; i++)
        {
            (await app.HandshakeStatusAsync(app.Agent.Slug, bearer)).Should().Be(HttpStatusCode.Unauthorized);
        }

        // Nem a consulta do token (texto sem a forma certa nunca vai ao banco) nem a de anotar a recusa: zero, sem limite a esperar.
        counter.Count.Should().Be(queries);
        (await app.DatabaseFingerprintAsync()).Should().Be(before);
    }

    [Fact]
    public async Task ARejectionNote_CostsAtMostOneQueryPerWellFormedUnknownToken_UntilTheGuardCutsIt()
    {
        var counter = new SlugAndBeaconQueryCounter();
        await using var app = await TransportApp.StartAsync(
            postgres, new DevicesAppOptions { CommandInterceptor = counter, TokenFailureLimit = 3 });
        var queries = counter.Count;

        // O teto de tokens inválidos por origem (3 aqui) corta antes de qualquer anotação: depois dele é 429 e nenhuma consulta nova.
        var statuses = new List<HttpStatusCode>();
        for (var i = 0; i < 12; i++)
        {
            statuses.Add(await app.HandshakeStatusAsync(app.Agent.Slug, DeviceSecrets.NewDeviceToken().Token));
        }

        statuses.Should().Contain(HttpStatusCode.TooManyRequests);
        // No máximo: uma procura de slug por tentativa que o teto deixou passar (3) mais a leitura e a gravação da única anotação aceita.
        counter.Count.Should().BeLessThanOrEqualTo(queries + 3 + 2);
    }

    [Fact]
    public async Task TheBeaconDoorHasAGlobalCeiling_SoRotatingAddressesCannotMultiplyQueries()
    {
        var counter = new SlugAndBeaconQueryCounter();
        await using var app = await TransportApp.StartAsync(postgres, new DevicesAppOptions { CommandInterceptor = counter });
        var queries = counter.Count;

        // Slugs diferentes (e inexistentes): o limite por agente nunca entra, só o teto geral.
        for (var i = 0; i < 160; i++)
        {
            using var response = await PostAsync(app, $"pc-fantasma-{i:000}", Body());
            response.StatusCode.Should().Be(HttpStatusCode.NoContent);
        }

        (counter.Count - queries).Should().BeLessThanOrEqualTo(120);
        (counter.Count - queries).Should().BeGreaterThan(0);
    }

    [Fact]
    public async Task ABeaconFlood_CannotBlindTheRefusalNotes()
    {
        await using var app = await TransportApp.StartAsync(postgres);

        // Esgota o teto geral das balizas com palpites de slug (cada um novo, então a memória de inexistentes não ajuda).
        for (var i = 0; i < 140; i++)
        {
            using var response = await PostAsync(app, $"pc-fantasma-{i:000}", Body());
            response.StatusCode.Should().Be(HttpStatusCode.NoContent);
        }

        // A recusa tem balde próprio: continua sendo anotada.
        (await app.HandshakeStatusAsync(app.Agent.Slug, DeviceSecrets.NewDeviceToken().Token)).Should().Be(HttpStatusCode.Unauthorized);
        (await RowAsync(app, app.Agent.Id))!.LastRejectReason.Should().Be("invalid_token");

        // E a baliza verdadeira do agente existente também passa, depois que a janela do teto geral vira.
        app.App.Time.Advance(TimeSpan.FromMinutes(1));
        using var real = await PostAsync(app, app.Agent.Slug, Body("supervisor", "no_config"));
        real.StatusCode.Should().Be(HttpStatusCode.NoContent);
        (await RowAsync(app, app.Agent.Id))!.LastStage.Should().Be("supervisor");
    }

    [Fact]
    public async Task TheRefusalDoor_HasItsOwnGlobalCeiling_EvenWhenTheAddressChanges()
    {
        var counter = new SlugAndBeaconQueryCounter();
        // O teto de tokens inválidos por origem não entra aqui (alto): é o endereço que muda, e só o teto geral das recusas segura.
        await using var app = await TransportApp.StartAsync(
            postgres, new DevicesAppOptions { CommandInterceptor = counter, TokenFailureLimit = 100000 });
        var queries = counter.Count;

        for (var i = 0; i < 100; i++)
        {
            (await app.HandshakeStatusAsync($"pc-fantasma-{i:000}", DeviceSecrets.NewDeviceToken().Token))
                .Should().Be(HttpStatusCode.Unauthorized);
        }

        // Cada tentativa gasta o teto antes de qualquer consulta: o excedente (40) não custa nada. É um limite aceito: quem esgota o
        // teto apaga as anotações de recusa de todos por um minuto, mas o custo ao banco é fixo.
        (counter.Count - queries).Should().BeLessThanOrEqualTo(60);
        (counter.Count - queries).Should().BeGreaterThan(0);
    }

    [Fact]
    public async Task AForgedInvalidToken_CannotTakeTheProtocolSlot_NorOverwriteTheProtocolRefusal()
    {
        await using var app = await TransportApp.StartAsync(postgres);
        await using var agent = await app.ConnectAsync();

        // Um token inventado no caminho do agente ocupa a vaga do "invalid_token" neste minuto...
        (await app.HandshakeStatusAsync(app.Agent.Slug, DeviceSecrets.NewDeviceToken().Token)).Should().Be(HttpStatusCode.Unauthorized);
        (await RowAsync(app, app.Agent.Id))!.LastRejectReason.Should().Be("invalid_token");

        // ...e a recusa de protocolo do hub, no mesmo minuto, ainda entra (a janela é por motivo).
        await agent.SendTextAsync(agent.Envelope("agent.hello.v1", new JsonObject { ["agentVersion"] = "9.9.9" }));
        await WaitForRejectionAsync(app, "protocol");

        // Um novo token inventado, no minuto seguinte, não apaga a recusa de protocolo.
        app.App.Time.Advance(TimeSpan.FromMinutes(1));
        (await app.HandshakeStatusAsync(app.Agent.Slug, DeviceSecrets.NewDeviceToken().Token)).Should().Be(HttpStatusCode.Unauthorized);
        (await RowAsync(app, app.Agent.Id))!.LastRejectReason.Should().Be("protocol");
    }

    [Fact]
    public async Task AnAcceptedHello_CostsNoBeaconQuery_WhenNoProtocolRefusalIsNoted()
    {
        var counter = new SlugAndBeaconQueryCounter(beaconTableOnly: true);
        await using var app = await TransportApp.StartAsync(postgres, new DevicesAppOptions { CommandInterceptor = counter });
        await using var agent = await app.ConnectAsync();

        // O primeiro hello confere o banco uma vez (processo novo); daí em diante o agente saudável não paga nada.
        await agent.SendHelloAsync("2.5.0", "tv.remote");
        await TransportApp.WaitUntilAsync(() => app.Presence.Get(app.Agent.Slug)?.AgentVersion == "2.5.0", "primeiro hello processado");
        // A limpeza roda logo depois da presença; um hello seguinte só é processado depois dela terminar.
        await agent.SendHelloAsync("2.5.1", "tv.remote");
        await TransportApp.WaitUntilAsync(() => app.Presence.Get(app.Agent.Slug)?.AgentVersion == "2.5.1", "segundo hello processado");
        var afterSecond = counter.Count;
        afterSecond.Should().BeLessThanOrEqualTo(1, "uma única atualização condicional, só no primeiro hello do processo");

        await agent.SendHelloAsync("2.5.2", "tv.remote");
        await TransportApp.WaitUntilAsync(() => app.Presence.Get(app.Agent.Slug)?.AgentVersion == "2.5.2", "terceiro hello processado");
        await agent.SendHelloAsync("2.5.3", "tv.remote");
        await TransportApp.WaitUntilAsync(() => app.Presence.Get(app.Agent.Slug)?.AgentVersion == "2.5.3", "quarto hello processado");

        counter.Count.Should().Be(afterSecond);
    }

    [Fact]
    public async Task ARepeatedGuessOfAMissingSlug_CostsOneQueryPerMinute()
    {
        var counter = new SlugAndBeaconQueryCounter();
        await using var app = await TransportApp.StartAsync(postgres, new DevicesAppOptions { CommandInterceptor = counter });
        var queries = counter.Count;

        for (var i = 0; i < 50; i++)
        {
            using var response = await PostAsync(app, "pc-que-nao-existe", Body());
            response.StatusCode.Should().Be(HttpStatusCode.NoContent);
        }

        (counter.Count - queries).Should().Be(1);

        app.App.Time.Advance(TimeSpan.FromMinutes(1));
        using var later = await PostAsync(app, "pc-que-nao-existe", Body());
        // Passado o minuto o palpite volta a ser procurado (o relógio andando também acorda rotinas de fundo, então só se exige que cresça).
        (counter.Count - queries).Should().BeGreaterThan(1);
    }

    /// <summary>Conta as consultas das duas portas anônimas: a procura do agente pelo slug e as leituras e gravações da tabela de balizas.</summary>
    private sealed class SlugAndBeaconQueryCounter(bool beaconTableOnly = false) : DbCommandInterceptor
    {
        private int _count;

        public int Count => Volatile.Read(ref _count);

        public override ValueTask<DbDataReader> ReaderExecutedAsync(
            DbCommand command, CommandExecutedEventData eventData, DbDataReader result, CancellationToken cancellationToken = default)
        {
            Observe(command);
            return base.ReaderExecutedAsync(command, eventData, result, cancellationToken);
        }

        public override ValueTask<int> NonQueryExecutedAsync(
            DbCommand command, CommandExecutedEventData eventData, int result, CancellationToken cancellationToken = default)
        {
            Observe(command);
            return base.NonQueryExecutedAsync(command, eventData, result, cancellationToken);
        }

        private void Observe(DbCommand command)
        {
            var text = command.CommandText;
            if (text.Contains("agent_beacons", StringComparison.OrdinalIgnoreCase)
                || (!beaconTableOnly && text.Contains("slug", StringComparison.OrdinalIgnoreCase) && text.Contains("agents", StringComparison.OrdinalIgnoreCase)
                    && !text.Contains("token_hash", StringComparison.OrdinalIgnoreCase)))
            {
                Interlocked.Increment(ref _count);
            }
        }
    }

    [Fact]
    public async Task AnAttemptWithoutAnyToken_WritesNothing()
    {
        await using var app = await TransportApp.StartAsync(postgres);
        var before = await app.DatabaseFingerprintAsync();

        // Sem cabeçalho a autorização responde antes do limitador de requisições: anotar aqui seria uma consulta por tentativa.
        (await app.HandshakeStatusAsync(app.Agent.Slug, bearer: null)).Should().Be(HttpStatusCode.Unauthorized);

        (await app.DatabaseFingerprintAsync()).Should().Be(before);
    }

    [Fact]
    public async Task AnotherAgentsToken_IsRecordedOnTheRouteSlug()
    {
        await using var app = await TransportApp.StartAsync(postgres);
        var other = await app.PairAnotherAsync("Outro PC");

        (await app.HandshakeStatusAsync(app.Agent.Slug, other.Token)).Should().Be(HttpStatusCode.Forbidden);

        await WaitForRejectionAsync(app, "wrong_agent");
        (await RowCountAsync(app)).Should().Be(1);
    }

    [Fact]
    public async Task ARejectionForAnUnknownSlug_WritesNothing()
    {
        await using var app = await TransportApp.StartAsync(postgres);
        var before = await app.DatabaseFingerprintAsync();

        (await app.HandshakeStatusAsync("nao-existe", app.Agent.Token)).Should().Be(HttpStatusCode.Forbidden);
        (await app.HandshakeStatusAsync("nao-existe", bearer: null)).Should().Be(HttpStatusCode.Unauthorized);

        (await app.DatabaseFingerprintAsync()).Should().Be(before);
    }

    [Fact]
    public async Task ARefusedHello_IsRecordedAsAProtocolRejection_AndTheConnectionStaysOpen()
    {
        await using var app = await TransportApp.StartAsync(postgres);
        await using var agent = await app.ConnectAsync();

        // Sem a lista de capacidades: o contrato do hello não aceita.
        await agent.SendTextAsync(agent.Envelope("agent.hello.v1", new JsonObject { ["agentVersion"] = "9.9.9" }));

        var row = await WaitForRejectionAsync(app, "protocol");
        row.LastRejectedAt.Should().NotBeNull();
        agent.State.Should().Be(System.Net.WebSockets.WebSocketState.Open);
    }

    private static async Task<JsonElement> ReadItemAsync(TransportApp app, Guid agentId)
    {
        using var response = await app.App.SendAsync(HttpMethod.Get, ReadUrl, bearer: app.Login.AccessToken);
        var json = await response.Content.ReadFromJsonAsync<JsonElement>(Ct);
        return json.GetProperty("items").EnumerateArray().Single(i => i.GetProperty("agentId").GetGuid() == agentId);
    }

    private static async Task<JsonElement> ReadAgentAsync(TransportApp app)
    {
        using var response = await app.App.ListAgentsRawAsync(app.Login);
        var json = await response.Content.ReadFromJsonAsync<JsonElement>(Ct);
        return json.EnumerateArray().Single(i => i.GetProperty("id").GetGuid() == app.Agent.Id);
    }

    [Fact]
    public async Task AProtocolRefusal_FromTheHub_ReachesTheReadModel_BeforeTheLastContact_UntilAnAcceptedHello()
    {
        await using var app = await TransportApp.StartAsync(postgres);
        await using var agent = await app.ConnectAsync();

        // Conectado e mudo: o hello fora do contrato é recusado com a conexão aberta.
        app.App.Time.Advance(TimeSpan.FromSeconds(5));
        await agent.SendTextAsync(agent.Envelope("agent.hello.v1", new JsonObject { ["agentVersion"] = "9.9.9" }));
        var refusal = await WaitForRejectionAsync(app, "protocol");
        var refusedAt = refusal.LastRejectedAt!.Value;

        var item = await ReadItemAsync(app, app.Agent.Id);
        item.GetProperty("rejectReason").GetString().Should().Be("protocol");
        item.GetProperty("rejectedAt").GetDateTimeOffset().Should().Be(refusedAt);
        (await ReadAgentAsync(app)).GetProperty("connected").GetBoolean().Should().BeTrue();

        // A queda grava o último contato DEPOIS da recusa: é essa ordem que a tela tem de aguentar (sem piso para o protocolo).
        app.App.Time.Advance(TimeSpan.FromSeconds(5));
        await agent.DisposeAsync();
        await TransportApp.WaitUntilAsync(async () => !(await ReadAgentAsync(app)).GetProperty("connected").GetBoolean(), "queda gravada");
        var after = await ReadAgentAsync(app);
        after.GetProperty("lastSeenAt").GetDateTimeOffset().Should().BeAfter(refusedAt);
        (await ReadItemAsync(app, app.Agent.Id)).GetProperty("rejectReason").GetString().Should().Be("protocol");

        // Reconectou e mandou um hello aceito: a recusa antiga sai.
        await using var fixedAgent = await app.ConnectAsync();
        await fixedAgent.SendHelloAsync("2.5.0", "tv.remote");
        await TransportApp.WaitUntilAsync(
            async () => (await RowAsync(app, app.Agent.Id))!.LastRejectReason is null, "recusa de protocolo limpa pelo hello aceito");
        (await ReadItemAsync(app, app.Agent.Id)).GetProperty("rejectReason").ValueKind.Should().Be(JsonValueKind.Null);
    }

    // ---- leitura ----

    [Fact]
    public async Task TheOwnerReadsTheLastBeaconAndTheLastRejectionOfEachAgent()
    {
        await using var app = await TransportApp.StartAsync(postgres);
        var other = await app.PairAnotherAsync("Outro PC");
        await PostAsync(app, app.Agent.Slug, Body("child_spawn", "crash_loop", "Saiu com codigo 3"));
        (await app.HandshakeStatusAsync(app.Agent.Slug, DeviceSecrets.NewDeviceToken().Token)).Should().Be(HttpStatusCode.Unauthorized);
        await WaitForRejectionAsync(app, "invalid_token");

        using var response = await app.App.SendAsync(HttpMethod.Get, ReadUrl, bearer: app.Login.AccessToken);

        response.StatusCode.Should().Be(HttpStatusCode.OK);
        response.Headers.CacheControl!.NoStore.Should().BeTrue();
        var json = await response.Content.ReadFromJsonAsync<JsonElement>(Ct);
        var items = json.GetProperty("items").EnumerateArray().ToList();
        items.Should().ContainSingle();
        var item = items[0];
        item.GetProperty("agentId").GetGuid().Should().Be(app.Agent.Id);
        item.GetProperty("stage").GetString().Should().Be("child_spawn");
        item.GetProperty("code").GetString().Should().Be("crash_loop");
        item.TryGetProperty("detail", out _).Should().BeFalse("texto livre de rota anônima não é guardado nem devolvido");
        item.GetProperty("verified").GetBoolean().Should().BeFalse();
        item.GetProperty("count").GetInt32().Should().Be(1);
        item.GetProperty("rejectReason").GetString().Should().Be("invalid_token");
        item.GetProperty("rejectedAt").GetDateTimeOffset().Should().Be(app.App.Time.GetUtcNow());
        item.GetProperty("version").GetString().Should().Be("0.42.10");
        other.Id.Should().NotBe(app.Agent.Id);
    }

    [Fact]
    public async Task ARevokedAgent_IsLeftOutOfTheRead()
    {
        await using var app = await TransportApp.StartAsync(postgres);
        await PostAsync(app, app.Agent.Slug, Body());
        using var revoke = await app.App.RevokeRawAsync(app.Login, app.Agent.Id, "teste");
        revoke.StatusCode.Should().Be(HttpStatusCode.OK);

        using var response = await app.App.SendAsync(HttpMethod.Get, ReadUrl, bearer: app.Login.AccessToken);

        response.StatusCode.Should().Be(HttpStatusCode.OK);
        var json = await response.Content.ReadFromJsonAsync<JsonElement>(Ct);
        json.GetProperty("items").GetArrayLength().Should().Be(0);
    }

    [Fact]
    public async Task TheReadIsOnlyForTheOwner()
    {
        await using var app = await TransportApp.StartAsync(postgres);
        await PostAsync(app, app.Agent.Slug, Body());
        var guest = await app.App.NewGuestAsync();

        using var anonymous = await app.App.SendAsync(HttpMethod.Get, ReadUrl);
        using var asGuest = await app.App.SendAsync(HttpMethod.Get, ReadUrl, bearer: guest.Login.AccessToken);

        anonymous.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
        asGuest.StatusCode.Should().Be(HttpStatusCode.Forbidden);
    }
}
