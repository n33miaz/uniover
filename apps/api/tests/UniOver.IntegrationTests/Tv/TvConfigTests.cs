using System.Net;
using System.Text.Json;
using AwesomeAssertions;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Npgsql;
using UniOver.IntegrationTests.Devices.Transport;
using UniOver.IntegrationTests.Guards;
using UniOver.IntegrationTests.Identity.Passkeys;
using UniOver.IntegrationTests.Infrastructure;
using UniOver.Modules.Tv;
using UniOver.Modules.Tv.Domain;
using UniOver.Modules.Tv.Persistence;
using UniOver.Modules.Tv.Ports;

namespace UniOver.IntegrationTests.Tv;

/// <summary>
/// O computador que controla a TV escolhido pelo app (e não só pela variável de ambiente): leitura, troca com passkey,
/// validação contra os agentes pareados, resolução banco > variável > nada, auditoria e o efeito nos comandos, no estado e
/// no fluxo ao vivo. Nada vai à TV de verdade: o agente é o falso.
/// </summary>
[Collection(PostgresGroup.Name)]
public sealed class TvConfigTests(PostgresFixture postgres)
{
    private const string ConfigUrl = "/api/v1/tv/config";
    private const string BindUrl = "/api/v1/tv/config/agent";
    private const string BindAction = "tv.bind-agent";

    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static async Task<T> Within<T>(Task<T> task) => await task.WaitAsync(FakeAgent.Patience, Ct);

    private static async Task<JsonElement> GetConfigAsync(TvApp app)
    {
        using var response = await app.GetAsync(ConfigUrl);
        response.StatusCode.Should().Be(HttpStatusCode.OK);
        return await TvApp.JsonAsync(response);
    }

    /// <summary>Dono com passkey cadastrada e a confirmação da troca em dia: a troca está liberada.</summary>
    private static async Task<VirtualAuthenticator> ConfirmedOwnerAsync(TvApp app)
    {
        var authenticator = new VirtualAuthenticator();
        await app.RegisterOwnerPasskeyAsync(authenticator);
        await app.ConfirmOwnerActionAsync(authenticator, BindAction);
        return authenticator;
    }

    private static Task<HttpResponseMessage> BindAsync(TvApp app, object body, string? bearer = "") =>
        app.SendAsync(HttpMethod.Put, BindUrl, body, bearer);

    private static async Task<HttpStatusCode> SendKeyAsync(TvApp app, FakeAgent? agent)
    {
        var request = app.PostAsync("/api/v1/tv/keys", new { key = "HOME" });
        if (agent is not null)
        {
            var command = await TvApp.NextCommandAsync(agent);
            await TvApp.ReplyAsync(agent, command);
        }

        using var response = await Within(request);
        return response.StatusCode;
    }

    private static string AgentSlugErrors(JsonElement problem) =>
        string.Join('|', problem.GetProperty("errors").GetProperty("agentSlug").EnumerateArray().Select(e => e.GetString()));

    // ----- leitura -----

    [Fact]
    public async Task Get_WithOnlyTheEnvironmentValue_ShowsItsOrigin_AndTheAgentState()
    {
        await using var app = await TvApp.StartAsync(postgres);

        var offline = await GetConfigAsync(app);
        offline.GetProperty("source").GetString().Should().Be("environment");
        offline.GetProperty("agentSlug").GetString().Should().Be(TvApp.AgentSlug);
        offline.GetProperty("agentName").GetString().Should().Be("PC Casa");
        offline.GetProperty("agentStatus").GetString().Should().Be("offline");
        offline.GetProperty("name").GetString().Should().Be("TV");
        var choice = offline.GetProperty("agents").EnumerateArray().Should().ContainSingle().Subject;
        choice.GetProperty("slug").GetString().Should().Be(TvApp.AgentSlug);
        choice.GetProperty("name").GetString().Should().Be("PC Casa");
        choice.GetProperty("platform").GetString().Should().Be("windows");
        choice.GetProperty("online").GetBoolean().Should().BeFalse();

        await using var agent = await app.ConnectAndWaitAsync();
        var online = await GetConfigAsync(app);
        online.GetProperty("agentStatus").GetString().Should().Be("online");
        online.GetProperty("agents")[0].GetProperty("online").GetBoolean().Should().BeTrue();
    }

    [Fact]
    public async Task Get_WithNothingConfigured_SaysSo_AndStillListsThePairedComputers()
    {
        await using var app = await TvApp.StartAsync(postgres, new TvAppOptions { AgentId = string.Empty });

        var config = await GetConfigAsync(app);

        config.GetProperty("source").GetString().Should().Be("none");
        config.GetProperty("agentSlug").ValueKind.Should().Be(JsonValueKind.Null);
        config.GetProperty("agentName").ValueKind.Should().Be(JsonValueKind.Null);
        config.GetProperty("agentStatus").GetString().Should().Be("unknown");
        config.GetProperty("agents").GetArrayLength().Should().Be(1);
    }

    [Fact]
    public async Task ConfigRoutes_RejectTvId_AndDoNotRebindTheDefaultTv()
    {
        await using var app = await TvApp.StartAsync(postgres);
        using var authenticator = await ConfirmedOwnerAsync(app);
        using (var bind = await BindAsync(app, new { agentSlug = TvApp.AgentSlug }))
        {
            bind.StatusCode.Should().Be(HttpStatusCode.OK);
        }

        var other = await app.PairAsync("PC Extra");
        var tvId = Guid.NewGuid();
        using (var get = await app.GetAsync($"{ConfigUrl}?tvId={tvId}"))
        {
            get.StatusCode.Should().Be(HttpStatusCode.BadRequest);
        }

        using (var bind = await app.SendAsync(HttpMethod.Put, $"{BindUrl}?tvId={tvId}", new { agentSlug = other.Slug }))
        {
            bind.StatusCode.Should().Be(HttpStatusCode.BadRequest);
        }

        var config = await GetConfigAsync(app);
        config.GetProperty("agentSlug").GetString().Should().Be(TvApp.AgentSlug, "a rota legada só administra a TV padrão");
    }

    [Fact]
    public async Task Get_WhenTheConfiguredComputerWasNeverPaired_IsUnknown()
    {
        await using var app = await TvApp.StartAsync(postgres, new TvAppOptions { AgentId = "fantasma" });

        var config = await GetConfigAsync(app);

        config.GetProperty("source").GetString().Should().Be("environment");
        config.GetProperty("agentSlug").GetString().Should().Be("fantasma");
        config.GetProperty("agentName").ValueKind.Should().Be(JsonValueKind.Null, "ninguém com esse identificador foi pareado");
        config.GetProperty("agentStatus").GetString().Should().Be("unknown");
    }

    [Fact]
    public async Task Get_WhenTheConfiguredComputerWasRevoked_SaysRevoked_AndTheListLeavesItOut()
    {
        await using var app = await TvApp.StartAsync(postgres);
        var second = await app.PairAsync("PC Novo");
        using (var revoke = await app.PostAsync($"/api/v1/devices/agents/{app.Agent.Id}/revoke"))
        {
            revoke.StatusCode.Should().Be(HttpStatusCode.OK);
        }

        var config = await GetConfigAsync(app);

        config.GetProperty("agentSlug").GetString().Should().Be(TvApp.AgentSlug);
        config.GetProperty("agentStatus").GetString().Should().Be("revoked");
        config.GetProperty("agentName").GetString().Should().Be("PC Casa", "o nome ainda ajuda a tela a explicar o que aconteceu");
        config.GetProperty("agents").EnumerateArray().Select(a => a.GetProperty("slug").GetString())
            .Should().Equal(second.Slug);
    }

    [Fact]
    public async Task Get_Lists_OnlyPairedAndNotRevokedComputers_WithoutAnyTokenField()
    {
        await using var app = await TvApp.StartAsync(postgres);
        var second = await app.PairAsync("PC Novo");
        var third = await app.PairAsync("Notebook");
        using (var revoke = await app.PostAsync($"/api/v1/devices/agents/{second.Id}/revoke"))
        {
            revoke.StatusCode.Should().Be(HttpStatusCode.OK);
        }

        using var response = await app.GetAsync(ConfigUrl);
        var raw = await response.Content.ReadAsStringAsync(Ct);
        var config = JsonDocument.Parse(raw).RootElement;

        config.GetProperty("agents").EnumerateArray().Select(a => a.GetProperty("slug").GetString())
            .Should().Equal(TvApp.AgentSlug, third.Slug);
        raw.Should().NotContain(app.Agent.Token).And.NotContain(third.Token);
        foreach (var agent in config.GetProperty("agents").EnumerateArray())
        {
            agent.EnumerateObject().Select(p => p.Name).Should().BeEquivalentTo("slug", "name", "platform", "online");
        }
    }

    // ----- quem pode -----

    [Fact]
    public async Task Anonymous_IsRefusedWith401_OnBothRoutes()
    {
        await using var app = await TvApp.StartAsync(postgres);

        using var read = await app.SendAsync(HttpMethod.Get, ConfigUrl, bearer: null);
        using var write = await BindAsync(app, new { agentSlug = TvApp.AgentSlug }, bearer: null);

        read.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
        write.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }

    private static readonly string[][] GuestPermissionSets =
    [
        ["module:tv", "tv:control", "tv:power", "tv:launch", "tv:history"],
        ["module:tv", "tv:control", "tv:power", "tv:launch", "tv:edit-shortcuts", "tv:history"],
        ["module:training"],
    ];

    [Fact]
    public async Task Guest_IsRefusedWith403_OnBothRoutes_WhateverTheTvPermissions()
    {
        await using var app = await TvApp.StartAsync(postgres);
        var ip = 40;
        foreach (var permissions in GuestPermissionSets)
        {
            var guest = await app.NewGuestAsync("Convidado", permissions, ip++);
            var before = await app.TvFingerprintAsync();

            using var read = await app.SendAsync(HttpMethod.Get, ConfigUrl, bearer: guest.Login.AccessToken);
            using var write = await BindAsync(app, new { agentSlug = TvApp.AgentSlug }, bearer: guest.Login.AccessToken);

            read.StatusCode.Should().Be(HttpStatusCode.Forbidden, string.Join(", ", permissions));
            write.StatusCode.Should().Be(HttpStatusCode.Forbidden, string.Join(", ", permissions));
            (await app.TvFingerprintAsync()).Should().Be(before, "o convidado não mexe em nada");
        }
    }

    [Fact]
    public async Task Put_WithoutTheConfirmation_Returns403StepUpRequired_AndSavesNothing()
    {
        await using var app = await TvApp.StartAsync(postgres);
        var second = await app.PairAsync("PC Novo");
        var before = await app.TvFingerprintAsync();

        using var response = await BindAsync(app, new { agentSlug = second.Slug });

        response.StatusCode.Should().Be(HttpStatusCode.Forbidden);
        var problem = await TvApp.JsonAsync(response);
        problem.GetProperty("type").GetString().Should().EndWith("/step-up-required");
        problem.GetProperty("action").GetString().Should().Be(BindAction);
        (await app.TvFingerprintAsync()).Should().Be(before);
        (await GetConfigAsync(app)).GetProperty("source").GetString().Should().Be("environment");
    }

    [Fact]
    public async Task Put_AfterConfirmingADifferentAction_StillAsksForTheRightOne()
    {
        await using var app = await TvApp.StartAsync(postgres);
        using var authenticator = new VirtualAuthenticator();
        await app.RegisterOwnerPasskeyAsync(authenticator);
        await app.ConfirmOwnerActionAsync(authenticator, "tv.power-off");
        var second = await app.PairAsync("PC Novo");

        using var response = await BindAsync(app, new { agentSlug = second.Slug });

        response.StatusCode.Should().Be(HttpStatusCode.Forbidden);
        (await TvApp.JsonAsync(response)).GetProperty("action").GetString().Should().Be(BindAction);
    }

    [Fact]
    public async Task Put_WhenTheConfirmationExpired_AsksAgain()
    {
        await using var app = await TvApp.StartAsync(postgres);
        using var authenticator = await ConfirmedOwnerAsync(app);
        var second = await app.PairAsync("PC Novo");

        // A confirmação vale 5 minutos; o token de acesso da sessão (10 min) ainda vale.
        app.Time.Advance(TimeSpan.FromMinutes(6));
        using var response = await BindAsync(app, new { agentSlug = second.Slug });

        response.StatusCode.Should().Be(HttpStatusCode.Forbidden);
        (await TvApp.JsonAsync(response)).GetProperty("type").GetString().Should().EndWith("/step-up-required");
    }

    // ----- salvar -----

    [Fact]
    public async Task Put_AfterTheConfirmation_SavesTheComputer_ReturnsTheNewConfig_AndAuditsIt()
    {
        await using var app = await TvApp.StartAsync(postgres);
        using var authenticator = await ConfirmedOwnerAsync(app);
        var second = await app.PairAsync("PC Novo");

        using var response = await BindAsync(app, new { agentSlug = second.Slug });

        response.StatusCode.Should().Be(HttpStatusCode.OK);
        var config = await TvApp.JsonAsync(response);
        config.GetProperty("source").GetString().Should().Be("saved");
        config.GetProperty("agentSlug").GetString().Should().Be(second.Slug);
        config.GetProperty("agentName").GetString().Should().Be("PC Novo");
        config.GetProperty("agentStatus").GetString().Should().Be("offline");
        (await GetConfigAsync(app)).GetProperty("agentSlug").GetString().Should().Be(second.Slug);

        await using var db = app.Db();
        var row = await db.Tvs.AsNoTracking().SingleAsync(Ct);
        row.AgentSlug.Should().Be(second.Slug);
        row.IsDefault.Should().BeTrue();
        row.Name.Should().Be("TV");
        row.UpdatedAt.Should().Be(app.Time.GetUtcNow());
        await using var identity = app.Identity();
        var owner = await identity.Users.SingleAsync(u => u.Email == app.OwnerEmail, Ct);
        row.UpdatedBy.Should().Be(owner.Id);

        var audit = await db.CommandAudit.AsNoTracking().SingleAsync(a => a.Command == "tv.config.bind", Ct);
        audit.Detail.Should().Be(second.Slug);
        audit.AgentId.Should().Be(second.Slug);
        audit.UserId.Should().Be(owner.Id);
        audit.Ok.Should().BeTrue();
        audit.ErrorCode.Should().BeNull();
        audit.Ip.Should().Be(TvApp.ClientIp);
        audit.UserAgent.Should().Be(TvApp.UserAgentText);
    }

    [Fact]
    public async Task Put_UnknownRevokedOrMalformedComputers_AreRefusedWithTheSameBody_AndNothingChanges()
    {
        await using var app = await TvApp.StartAsync(postgres);
        using var authenticator = await ConfirmedOwnerAsync(app);
        var revoked = await app.PairAsync("PC Velho");
        using (var revoke = await app.PostAsync($"/api/v1/devices/agents/{revoked.Id}/revoke"))
        {
            revoke.StatusCode.Should().Be(HttpStatusCode.OK);
        }

        var before = await app.TvFingerprintAsync();
        var bodies = new List<string>();
        var messages = new HashSet<string>();
        foreach (var slug in new[] { "fantasma", revoked.Slug, "../../etc/passwd", "PC-CASA", new string('a', 41), "' OR 1=1 --", " ", string.Empty })
        {
            using var response = await BindAsync(app, new { agentSlug = slug });

            response.StatusCode.Should().Be(HttpStatusCode.BadRequest, $"o slug '{slug}'");
            var problem = await TvApp.JsonAsync(response);
            problem.GetProperty("type").GetString().Should().EndWith("/validation-failed");
            messages.Add(AgentSlugErrors(problem));
            bodies.Add(problem.GetProperty("title").GetString() + "|" + problem.GetProperty("status").GetInt32());
        }

        using (var missing = await BindAsync(app, new { }))
        {
            missing.StatusCode.Should().Be(HttpStatusCode.BadRequest);
            messages.Add(AgentSlugErrors(await TvApp.JsonAsync(missing)));
        }

        messages.Should().ContainSingle("sem pista de qual dos casos foi: nunca pareado, revogado, fora do formato ou ausente");
        bodies.Distinct().Should().ContainSingle();
        (await app.TvFingerprintAsync()).Should().Be(before);
    }

    [Fact]
    public async Task Put_TheSlugOfAnotherAccountOrPersonIsNeverTrusted_OnlyTheListIsValid()
    {
        await using var app = await TvApp.StartAsync(postgres);
        using var authenticator = await ConfirmedOwnerAsync(app);

        // Um slug que um cliente inventa e que ainda não existe é recusado; depois de pareado, passa.
        using (var before = await BindAsync(app, new { agentSlug = "pc-novo" }))
        {
            before.StatusCode.Should().Be(HttpStatusCode.BadRequest);
        }

        var paired = await app.PairAsync("PC Novo");
        paired.Slug.Should().Be("pc-novo");
        using var after = await BindAsync(app, new { agentSlug = "pc-novo" });

        after.StatusCode.Should().Be(HttpStatusCode.OK);
    }

    [Fact]
    public async Task Put_SavingTheSameComputerAgain_WritesAndAuditsNothingNew()
    {
        await using var app = await TvApp.StartAsync(postgres);
        using var authenticator = await ConfirmedOwnerAsync(app);
        var second = await app.PairAsync("PC Novo");
        (await BindAsync(app, new { agentSlug = second.Slug })).Dispose();
        var before = await app.TvFingerprintAsync();

        app.Time.Advance(TimeSpan.FromMinutes(1));
        using var again = await BindAsync(app, new { agentSlug = second.Slug });

        again.StatusCode.Should().Be(HttpStatusCode.OK);
        (await TvApp.JsonAsync(again)).GetProperty("agentSlug").GetString().Should().Be(second.Slug);
        (await app.TvFingerprintAsync()).Should().Be(before, "a TV e a trilha ficam como estavam");
    }

    [Fact]
    public async Task Put_SavingTheValueThatCameFromTheEnvironment_CreatesTheRow_SoTheVariableCanGo()
    {
        await using var app = await TvApp.StartAsync(postgres);
        using var authenticator = await ConfirmedOwnerAsync(app);
        (await GetConfigAsync(app)).GetProperty("source").GetString().Should().Be("environment");

        using var response = await BindAsync(app, new { agentSlug = TvApp.AgentSlug });

        response.StatusCode.Should().Be(HttpStatusCode.OK);
        (await TvApp.JsonAsync(response)).GetProperty("source").GetString().Should().Be("saved");
        await using var db = app.Db();
        (await db.Tvs.AsNoTracking().SingleAsync(Ct)).AgentSlug.Should().Be(TvApp.AgentSlug);
        (await db.CommandAudit.CountAsync(a => a.Command == "tv.config.bind", Ct)).Should().Be(1);
    }

    [Fact]
    public async Task Put_WithoutAnyEnvironmentValue_MakesTheCommandsWork_FromTheSavedOne()
    {
        await using var app = await TvApp.StartAsync(postgres, new TvAppOptions { AgentId = string.Empty });
        using var authenticator = await ConfirmedOwnerAsync(app);
        await using var agent = await app.ConnectAndWaitAsync();

        using (var before = await app.PostAsync("/api/v1/tv/keys", new { key = "HOME" }))
        {
            before.StatusCode.Should().Be(HttpStatusCode.ServiceUnavailable);
            (await TvApp.JsonAsync(before)).GetProperty("type").GetString().Should().EndWith("/agent-not-configured");
        }

        using (var bind = await BindAsync(app, new { agentSlug = TvApp.AgentSlug }))
        {
            bind.StatusCode.Should().Be(HttpStatusCode.OK);
        }

        (await SendKeyAsync(app, agent)).Should().Be(HttpStatusCode.OK);
    }

    [Fact]
    public async Task Put_TheNameIsOptional_Validated_AndKeptWhenOmitted()
    {
        await using var app = await TvApp.StartAsync(postgres);
        using var authenticator = await ConfirmedOwnerAsync(app);

        using (var named = await BindAsync(app, new { agentSlug = TvApp.AgentSlug, name = "  TV da sala  " }))
        {
            named.StatusCode.Should().Be(HttpStatusCode.OK);
            (await TvApp.JsonAsync(named)).GetProperty("name").GetString().Should().Be("TV da sala");
        }

        var second = await app.PairAsync("PC Novo");
        using (var kept = await BindAsync(app, new { agentSlug = second.Slug }))
        {
            (await TvApp.JsonAsync(kept)).GetProperty("name").GetString().Should().Be("TV da sala", "sem nome, o atual fica");
        }

        var before = await app.TvFingerprintAsync();
        foreach (var bad in new[]
        {
            new string('n', 61), "TV\nsala", "TV\u0000sala",
            "\U0000202Eatv", "TV\U0000200Bsala", "TV\U0000200Esala", "TV\U00002028sala", "\U0000FEFFTV",
        })
        {
            using var response = await BindAsync(app, new { agentSlug = TvApp.AgentSlug, name = bad });
            response.StatusCode.Should().Be(HttpStatusCode.BadRequest);
            (await TvApp.JsonAsync(response)).GetProperty("errors").TryGetProperty("name", out _).Should().BeTrue();
        }

        (await app.TvFingerprintAsync()).Should().Be(before);
    }

    [Fact]
    public async Task Put_WhenTheAuditCannotBeWritten_TheChangeIsNotSaved_AndTheOldValueKeepsWorking()
    {
        await using var app = await TvApp.StartAsync(postgres, new TvAppOptions
        {
            ConfigureServices = services =>
            {
                services.RemoveAll<ITvCommandAudit>();
                services.AddScoped<ITvCommandAudit, ThrowingAudit>();
            },
        });
        using var authenticator = await ConfirmedOwnerAsync(app);
        var second = await app.PairAsync("PC Novo");
        var before = await app.TvFingerprintAsync();

        using var response = await BindAsync(app, new { agentSlug = second.Slug });

        response.StatusCode.Should().Be(HttpStatusCode.InternalServerError);
        (await app.TvFingerprintAsync()).Should().Be(before, "sem registro de quem trocou, a troca não vale");
        var config = await GetConfigAsync(app);
        config.GetProperty("source").GetString().Should().Be("environment");
        config.GetProperty("agentSlug").GetString().Should().Be(TvApp.AgentSlug);
    }

    private sealed class ThrowingAudit : ITvCommandAudit
    {
        public Task RecordAsync(CommandAuditEntry entry, CancellationToken cancellationToken) =>
            throw new InvalidOperationException("banco fora do ar");
    }

    /// <summary>Roda uma ação uma única vez, no instante em que o primeiro salvamento está prestes a gravar.</summary>
    private sealed class RaceHook
    {
        private int _used;

        public Func<Task>? BeforeTheFirstSave { get; set; }

        public async Task RunOnceAsync()
        {
            if (Interlocked.Exchange(ref _used, 1) == 0 && BeforeTheFirstSave is { } action)
            {
                await action();
            }
        }
    }

    /// <summary>
    /// A auditoria de verdade, só que o outro salvamento "ganha a corrida" um instante antes: o <c>RecordAsync</c> é o
    /// último passo antes do único <c>SaveChanges</c> da troca, então a linha do concorrente já existe quando o nosso
    /// INSERT chega ao índice único. Sempre acontece, sem depender de sorte de agendamento.
    /// </summary>
    private sealed class RacingAudit(TvDbContext db, RaceHook hook) : ITvCommandAudit
    {
        public async Task RecordAsync(CommandAuditEntry entry, CancellationToken cancellationToken)
        {
            await hook.RunOnceAsync();
            db.CommandAudit.Add(entry);
            await db.SaveChangesAsync(cancellationToken);
        }
    }

    private static TvAppOptions Racing(RaceHook hook) => new()
    {
        ConfigureServices = services =>
        {
            services.RemoveAll<ITvCommandAudit>();
            services.AddSingleton(hook);
            services.AddScoped<ITvCommandAudit, RacingAudit>();
        },
    };

    private static string InsertDefaultTv(string agentSlug) =>
        "INSERT INTO tv.tvs (id, name, agent_slug, is_default, created_at, updated_at, updated_by) " +
        $"VALUES (gen_random_uuid(), 'TV', '{agentSlug}', true, now(), now(), gen_random_uuid())";

    [Fact]
    public async Task Put_WhenTwoFirstSavesRace_AndTheOtherChoseTheSameComputer_IsIdempotentWithoutAServerError()
    {
        var hook = new RaceHook();
        await using var app = await TvApp.StartAsync(postgres, Racing(hook));
        using var authenticator = await ConfirmedOwnerAsync(app);
        var second = await app.PairAsync("PC Novo");
        hook.BeforeTheFirstSave = () => app.ExecuteSqlAsync(InsertDefaultTv(second.Slug));

        using var response = await BindAsync(app, new { agentSlug = second.Slug });

        response.StatusCode.Should().Be(HttpStatusCode.OK, "a corrida não pode virar erro 500");
        (await TvApp.JsonAsync(response)).GetProperty("agentSlug").GetString().Should().Be(second.Slug);
        await using var db = app.Db();
        (await db.Tvs.AsNoTracking().SingleAsync(Ct)).AgentSlug.Should().Be(second.Slug);
        (await db.CommandAudit.CountAsync(a => a.Command == "tv.config.bind", Ct)).Should().Be(0, "nada foi trocado por este pedido: não há o que registrar");
        (await GetConfigAsync(app)).GetProperty("source").GetString().Should().Be("saved");
    }

    [Fact]
    public async Task Put_WhenTwoFirstSavesRace_AndTheOtherChoseAnotherComputer_TheLastOneWins_AndIsAudited()
    {
        var hook = new RaceHook();
        await using var app = await TvApp.StartAsync(postgres, Racing(hook));
        using var authenticator = await ConfirmedOwnerAsync(app);
        var second = await app.PairAsync("PC Novo");
        hook.BeforeTheFirstSave = () => app.ExecuteSqlAsync(InsertDefaultTv(TvApp.AgentSlug));

        using var response = await BindAsync(app, new { agentSlug = second.Slug });

        response.StatusCode.Should().Be(HttpStatusCode.OK);
        (await TvApp.JsonAsync(response)).GetProperty("agentSlug").GetString().Should().Be(second.Slug);
        await using var db = app.Db();
        (await db.Tvs.AsNoTracking().SingleAsync(Ct)).AgentSlug.Should().Be(second.Slug, "a troca de quem chegou por último vale");
        var audit = await db.CommandAudit.AsNoTracking().SingleAsync(a => a.Command == "tv.config.bind", Ct);
        audit.Detail.Should().Be(second.Slug, "a troca que valeu tem o seu registro, uma vez só");
        (await GetConfigAsync(app)).GetProperty("agentSlug").GetString().Should().Be(second.Slug);
    }

    // ----- o efeito na TV -----

    [Fact]
    public async Task Switching_SendsTheNextCommandsToTheNewComputer_AndIgnoresTheOldOne()
    {
        // A variável segue apontando para o computador antigo: é a linha salva que manda.
        await using var app = await TvApp.StartAsync(postgres);
        using var authenticator = await ConfirmedOwnerAsync(app);
        var second = await app.PairAsync("PC Novo");
        await using var oldAgent = await app.ConnectAndWaitAsync();
        await using var newAgent = await app.ConnectAsync(second);
        await TvApp.WaitUntilAsync(() => app.Presence.Get(second.Slug)?.Connected == true, "computador novo conectado");

        (await SendKeyAsync(app, oldAgent)).Should().Be(HttpStatusCode.OK);
        using (var bind = await BindAsync(app, new { agentSlug = second.Slug }))
        {
            bind.StatusCode.Should().Be(HttpStatusCode.OK);
        }

        // Daqui em diante o antigo fica ouvindo: qualquer mensagem que a API lhe mandasse terminaria esta leitura.
        var oldAgentHears = oldAgent.ReceiveAsync();

        var request = app.PostAsync("/api/v1/tv/keys", new { key = "MUTE" });
        var command = await TvApp.NextCommandAsync(newAgent);
        command.GetProperty("target").GetString().Should().Be($"agent:{second.Slug}");
        command.GetProperty("body").GetProperty("key").GetString().Should().Be("MUTE");
        await TvApp.ReplyAsync(newAgent, command);
        using (var delivered = await Within(request))
        {
            delivered.StatusCode.Should().Be(HttpStatusCode.OK);
        }

        // O antigo não recebeu nada depois da troca. Revogá-lo fecha a sessão dele: a leitura pendente só termina com o
        // fechamento (nulo), sem ter visto mensagem nenhuma.
        oldAgentHears.IsCompleted.Should().BeFalse("o comando foi para o computador novo");
        using (var revoke = await app.PostAsync($"/api/v1/devices/agents/{app.Agent.Id}/revoke"))
        {
            revoke.StatusCode.Should().Be(HttpStatusCode.OK);
        }

        (await Within(oldAgentHears)).Should().BeNull("só o fechamento da sessão chegou ao computador antigo");

        await using var db = app.Db();
        var keys = await db.CommandAudit.AsNoTracking().Where(a => a.Command == "tv.key").OrderBy(a => a.OccurredAt).ThenBy(a => a.Id).ToListAsync(Ct);
        keys.Select(k => k.AgentId).Should().BeEquivalentTo([TvApp.AgentSlug, second.Slug]);
    }

    [Fact]
    public async Task Switching_StopsTrustingTheOldComputersMessages_AndStartsTrustingTheNewOne()
    {
        await using var app = await TvApp.StartAsync(postgres);
        using var authenticator = await ConfirmedOwnerAsync(app);
        var second = await app.PairAsync("PC Novo");
        await using var oldAgent = await app.ConnectAndWaitAsync();
        await using var newAgent = await app.ConnectAsync(second);
        await TvApp.WaitUntilAsync(() => app.Presence.Get(second.Slug)?.Connected == true, "computador novo conectado");
        (await BindAsync(app, new { agentSlug = second.Slug })).Dispose();

        // O antigo ainda fala (estado e lista de apps), mas já não vale; o novo vale.
        await oldAgent.SendTextAsync(oldAgent.Envelope("tv.state.v1", TvApp.StateBody(power: "on", volume: 99)));
        await oldAgent.SendTextAsync(oldAgent.Envelope("tv.apps.v1", TvApp.AppsBody(("com.antigo.app", "Do antigo"))));
        await newAgent.SendTextAsync(newAgent.Envelope("tv.state.v1", TvApp.StateBody(power: "off", volume: 3)));
        await TvApp.WaitUntilAsync(async () =>
        {
            using var s = await app.GetAsync("/api/v1/tv/state");
            return (await TvApp.JsonAsync(s)).GetProperty("power").GetString() == "off";
        }, "estado do computador novo");

        using var state = await app.GetAsync("/api/v1/tv/state");
        var body = await TvApp.JsonAsync(state);
        body.GetProperty("volume").GetInt32().Should().Be(3);
        body.GetProperty("agentOnline").GetBoolean().Should().BeTrue();

        await using var db = app.Db();
        (await db.Shortcuts.CountAsync(Ct)).Should().Be(0, "a lista de apps do computador antigo foi ignorada");
    }

    [Fact]
    public async Task Switching_TellsTheOpenScreens_EvenWhenTheNewComputerWasNeverSeen()
    {
        await using var app = await TvApp.StartAsync(postgres);
        using var authenticator = await ConfirmedOwnerAsync(app);
        var second = await app.PairAsync("PC Novo");
        await using var oldAgent = await app.ConnectAndWaitAsync();
        await oldAgent.SendTextAsync(oldAgent.Envelope("tv.state.v1", TvApp.StateBody(power: "on", volume: 21)));
        await TvApp.WaitUntilAsync(async () =>
        {
            using var s = await app.GetAsync("/api/v1/tv/state");
            return (await TvApp.JsonAsync(s)).GetProperty("power").GetString() == "on";
        }, "estado do computador antigo");

        var ticket = await app.StreamTicketAsync();
        using var stream = await app.OpenEventsAsync(ticket);
        using var reader = new SseReader(await stream.Content.ReadAsStreamAsync(Ct));
        var first = (await reader.NextAsync())!;
        first.EventType.Should().Be("tv.state");
        first.Data!.Value.GetProperty("power").GetString().Should().Be("on");
        (await reader.NextAsync())!.EventType.Should().Be("tv.shortcuts");

        (await BindAsync(app, new { agentSlug = second.Slug })).Dispose();

        var afterSwitch = (await reader.NextAsync())!;
        afterSwitch.EventType.Should().Be("tv.state");
        afterSwitch.Data!.Value.GetProperty("agentOnline").GetBoolean().Should().BeFalse("o computador novo ainda não conectou");
        afterSwitch.Data!.Value.GetProperty("power").GetString().Should().Be("unknown", "o estado do antigo não vale para o novo");

        // Quando o novo conecta, a tela é avisada pela presença, sem ninguém pedir.
        await using var newAgent = await app.ConnectAsync(second);
        var connected = (await reader.NextAsync())!;
        connected.EventType.Should().Be("tv.state");
        connected.Data!.Value.GetProperty("agentOnline").GetBoolean().Should().BeTrue();
    }

    [Fact]
    public async Task Presence_AfterARestart_IsStillRecognisedForTheSavedComputer_EvenWithNothingReadYet()
    {
        await using var app = await TvApp.StartAsync(postgres, new TvAppOptions { AgentId = string.Empty });
        using var authenticator = await ConfirmedOwnerAsync(app);
        (await BindAsync(app, new { agentSlug = TvApp.AgentSlug })).Dispose();

        var ticket = await app.StreamTicketAsync();
        using var stream = await app.OpenEventsAsync(ticket);
        using var reader = new SseReader(await stream.Content.ReadAsStreamAsync(Ct));
        (await reader.NextAsync())!.EventType.Should().Be("tv.state");
        (await reader.NextAsync())!.EventType.Should().Be("tv.shortcuts");

        // Como se a API tivesse acabado de subir: nenhum valor em memória, o computador conecta antes de qualquer leitura.
        app.Services.GetRequiredService<ITvAgentResolver>().Invalidate();
        await using var agent = await app.ConnectAsync();

        var connected = (await reader.NextAsync())!;
        connected.EventType.Should().Be("tv.state");
        connected.Data!.Value.GetProperty("agentOnline").GetBoolean().Should().BeTrue();
    }

    [Fact]
    public async Task TheSavedValue_BeatsTheEnvironment_AlsoAfterTheCacheExpires_AndAnOutsideChangeIsPickedUp()
    {
        await using var app = await TvApp.StartAsync(postgres);
        using var authenticator = await ConfirmedOwnerAsync(app);
        var second = await app.PairAsync("PC Novo");
        await using var newAgent = await app.ConnectAsync(second);
        await TvApp.WaitUntilAsync(() => app.Presence.Get(second.Slug)?.Connected == true, "computador novo conectado");
        (await BindAsync(app, new { agentSlug = second.Slug })).Dispose();

        // Passado o prazo do cache, o valor é lido de novo do banco e continua sendo o salvo (não o da variável).
        app.Time.Advance(TimeSpan.FromSeconds(31));
        (await GetConfigAsync(app)).GetProperty("agentSlug").GetString().Should().Be(second.Slug);

        // Uma mudança feita por fora (SQL) só vale depois do prazo curto.
        await app.ExecuteSqlAsync($"UPDATE tv.tvs SET agent_slug = '{TvApp.AgentSlug}'");
        (await GetConfigAsync(app)).GetProperty("agentSlug").GetString().Should().Be(second.Slug, "ainda dentro do prazo do cache");
        app.Time.Advance(TimeSpan.FromSeconds(31));
        (await GetConfigAsync(app)).GetProperty("agentSlug").GetString().Should().Be(TvApp.AgentSlug);
    }

    [Fact]
    public async Task WhenTheBoundComputerIsRevoked_CommandsFailAsOffline_AndTheConfigSaysRevoked()
    {
        await using var app = await TvApp.StartAsync(postgres);
        await using var agent = await app.ConnectAndWaitAsync();
        using (var revoke = await app.PostAsync($"/api/v1/devices/agents/{app.Agent.Id}/revoke"))
        {
            revoke.StatusCode.Should().Be(HttpStatusCode.OK);
        }

        // Revogar fecha a sessão do computador; esperar o fechamento deixa o agente falso sem nada pendente ao sair.
        await Within(agent.WaitForCloseAsync());
        await TvApp.WaitUntilAsync(() => app.Presence.Get(TvApp.AgentSlug)?.Connected == false, "agente caiu");
        app.PassReconnectGrace();
        using var key = await app.PostAsync("/api/v1/tv/keys", new { key = "HOME" });

        key.StatusCode.Should().Be(HttpStatusCode.ServiceUnavailable);
        (await GetConfigAsync(app)).GetProperty("agentStatus").GetString().Should().Be("revoked");
    }

    [Fact]
    public async Task WithTheEnvironmentValueAndNoRow_EverythingWorksAsBefore()
    {
        await using var app = await TvApp.StartAsync(postgres);
        await using var agent = await app.ConnectAndWaitAsync();
        await agent.SendTextAsync(agent.Envelope("tv.state.v1", TvApp.StateBody(power: "on", volume: 12)));
        await TvApp.WaitUntilAsync(async () =>
        {
            using var s = await app.GetAsync("/api/v1/tv/state");
            return (await TvApp.JsonAsync(s)).GetProperty("power").GetString() == "on";
        }, "estado recebido");

        (await SendKeyAsync(app, agent)).Should().Be(HttpStatusCode.OK);

        await using var db = app.Db();
        (await db.Tvs.CountAsync(Ct)).Should().Be(0, "ler e comandar nunca criam a linha sozinhos");
    }

    // ----- o esquema -----

    [Fact]
    public async Task Schema_AllowsExactlyOneDefaultTv_AndOnlyOneTvPerComputer()
    {
        await using var app = await TvApp.StartAsync(postgres);
        const string Insert = "INSERT INTO tv.tvs (id, name, agent_slug, is_default, created_at, updated_at, updated_by) " +
            "VALUES (gen_random_uuid(), 'TV', '{0}', {1}, now(), now(), gen_random_uuid())";

        await app.ExecuteSqlAsync(string.Format(System.Globalization.CultureInfo.InvariantCulture, Insert, "pc-a", "true"));

        var second = await FluentActions.Awaiting(() => app.ExecuteSqlAsync(
                string.Format(System.Globalization.CultureInfo.InvariantCulture, Insert, "pc-b", "true")))
            .Should().ThrowAsync<PostgresException>();
        second.Which.SqlState.Should().Be(PostgresErrorCodes.UniqueViolation, "só uma TV padrão");

        // Cada agente tem uma única TV para que as mensagens e o estado tenham um destino inequívoco: nem a padrão (pc-a)
        // nem outra TV podem repetir um agente já usado.
        await app.ExecuteSqlAsync(string.Format(System.Globalization.CultureInfo.InvariantCulture, Insert, "pc-c", "false"));
        var repeated = await FluentActions.Awaiting(() => app.ExecuteSqlAsync(
                string.Format(System.Globalization.CultureInfo.InvariantCulture, Insert, "pc-c", "false")))
            .Should().ThrowAsync<PostgresException>();
        repeated.Which.SqlState.Should().Be(PostgresErrorCodes.UniqueViolation, "um agente controla uma única TV");
        await using var db = app.Db();
        (await db.Tvs.CountAsync(Ct)).Should().Be(2);
    }

    [Fact]
    public async Task Schema_TheRuntimeRoleCanReadAndWriteTheNewTable_ButHasNoForeignKeyToOtherSchemas()
    {
        await using var app = await TvApp.StartAsync(postgres);
        using var authenticator = await ConfirmedOwnerAsync(app);

        // O papel da aplicação (sem DDL) grava pela API: se a tabela nova não tivesse o direito, o PUT falharia.
        using var response = await BindAsync(app, new { agentSlug = TvApp.AgentSlug });

        response.StatusCode.Should().Be(HttpStatusCode.OK);
        var references = await SchemaGuardQueries.RunAsync(app.Database.OwnerConnection, SchemaGuardQueries.CrossSchemaForeignKeys, Ct);
        references.Should().BeEmpty();
    }
}
