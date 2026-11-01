using System.Net;
using AwesomeAssertions;
using UniOver.IntegrationTests.Devices.Transport;
using UniOver.IntegrationTests.Identity.Passkeys;
using UniOver.IntegrationTests.Infrastructure;

namespace UniOver.IntegrationTests.Tv;

/// <summary>
/// O fluxo ao vivo da TV reavalia a permissão com o fluxo aberto: quem perde <c>module:tv</c> (ou é revogado) tem o fluxo
/// encerrado, com o fluxo parado e também com ele movimentado. O relógio é o falso e anda em passos de 5 s; os prazos
/// seguem o keep-alive (15 s) e o cache das permissões (30 s).
/// </summary>
[Collection(PostgresGroup.Name)]
public sealed class TvStreamPermissionTests(PostgresFixture postgres)
{
    private const int StepSeconds = 5;

    private const int GiveUpAfterSeconds = 180;

    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static readonly string[] TrainingOnly = ["module:training"];

    private static readonly string[] ModuleOnly = ["module:tv"];

    private static async Task<HttpResponseMessage> OpenAsync(TvApp app, string bearer)
    {
        var response = await app.OpenEventsAsync(await app.StreamTicketAsync(bearer));
        response.StatusCode.Should().Be(HttpStatusCode.OK);
        return response;
    }

    /// <summary>Lê o instantâneo que abre o fluxo (estado e atalhos).</summary>
    private static async Task<SseReader> ReadSnapshotAsync(HttpResponseMessage response)
    {
        var reader = new SseReader(await response.Content.ReadAsStreamAsync(Ct));
        (await reader.NextAsync())!.EventType.Should().Be("tv.state");
        (await reader.NextAsync())!.EventType.Should().Be("tv.shortcuts");
        return reader;
    }

    /// <summary>
    /// Anda o relógio em passos de 5 s até o próximo quadro; devolve o quadro (nulo quando o servidor encerrou o fluxo) e os
    /// segundos que passaram desde <paramref name="elapsed"/>.
    /// </summary>
    private static async Task<(SseFrame? Frame, int Elapsed)> AdvanceUntilFrameAsync(TvApp app, SseReader reader, int elapsed)
    {
        var next = reader.NextAsync();
        while (!next.IsCompleted)
        {
            elapsed.Should().BeLessThan(GiveUpAfterSeconds, "o fluxo não terminou nem mostrou um quadro com o relógio andando");
            app.Time.Advance(TimeSpan.FromSeconds(StepSeconds));
            elapsed += StepSeconds;
            await Task.Delay(25, Ct);
        }

        return (await next, elapsed);
    }

    [Fact]
    public async Task Stream_ClosesAtTheNextKeepAlive_WhenTheOwnerTakesAwayTheTvThroughTheApi()
    {
        await using var app = await TvApp.StartAsync(postgres);
        using var authenticator = new VirtualAuthenticator();
        await app.RegisterOwnerPasskeyAsync(authenticator);
        var guest = await app.NewGuestAsync("Alice", null, 40);
        using var response = await OpenAsync(app, guest.Login.AccessToken);
        using var reader = await ReadSnapshotAsync(response);

        (await app.ChangeGuestPermissionsAsync(authenticator, guest.UserId, TrainingOnly)).Should().Be(HttpStatusCode.OK);
        var (frame, elapsed) = await AdvanceUntilFrameAsync(app, reader, 0);

        frame.Should().BeNull("sem module:tv o fluxo é encerrado");
        elapsed.Should().BeLessThanOrEqualTo(15, "a mudança pela API esquece o cache: vale no próximo keep-alive");
    }

    [Fact]
    public async Task Stream_ClosesWithinTheCacheLifetime_WhenTheGrantIsRemovedBehindTheCache()
    {
        // Outra instância: o banco muda sem passar pela invalidação desta. Vale quando o cache de 30 s vence.
        await using var app = await TvApp.StartAsync(postgres);
        var guest = await app.NewGuestAsync("Alice", null, 41);
        using var response = await OpenAsync(app, guest.Login.AccessToken);
        using var reader = await ReadSnapshotAsync(response);

        await app.ExecuteSqlAsync($"DELETE FROM identity.user_grants WHERE user_id = '{guest.UserId}' AND permission = 'module:tv'");

        var elapsed = 0;
        SseFrame? frame;
        do
        {
            (frame, elapsed) = await AdvanceUntilFrameAsync(app, reader, elapsed);
            frame?.Comment.Should().Be("keep-alive", "enquanto o cache vale o fluxo segue aberto, só com keep-alive");
        }
        while (frame is not null);

        elapsed.Should().BeInRange(30, 45, "não antes do cache vencer (30 s) e no máximo um keep-alive depois");
    }

    [Fact]
    public async Task Stream_BusyWithEvents_ClosesOnceTheGuestIsRevoked_EvenThoughTheKeepAliveNeverFires()
    {
        await using var app = await TvApp.StartAsync(postgres);
        await using var agent = await app.ConnectAndWaitAsync();
        var guest = await app.NewGuestAsync("Alice", null, 42);
        using var response = await OpenAsync(app, guest.Login.AccessToken);
        using var reader = await ReadSnapshotAsync(response);

        using var revoke = await app.SendAsync(HttpMethod.Post, $"/api/v1/identity/guests/{guest.UserId}/revoke");
        revoke.StatusCode.Should().Be(HttpStatusCode.NoContent);

        // A TV em uso: um evento a cada 5 s, sempre menos que os 15 s do keep-alive, que por isso nunca dispara.
        var elapsed = 0;
        var closed = false;
        for (var i = 0; i < GiveUpAfterSeconds / StepSeconds && !closed; i++)
        {
            await agent.SendTextAsync(agent.Envelope("tv.state.v1", TvApp.StateBody(volume: 20 + i)));
            app.Time.Advance(TimeSpan.FromSeconds(StepSeconds));
            elapsed += StepSeconds;

            // A conferência do vigia lê o banco depois do disparo do relógio: dá a ela o tempo real de terminar antes do próximo passo.
            await Task.Delay(100, Ct);
            closed = await reader.NextAsync() is null;
        }

        closed.Should().BeTrue("o fluxo movimentado também é reavaliado, por relógio próprio");
        elapsed.Should().BeLessThanOrEqualTo(25, "um intervalo de reavaliação (15 s) mais um passo para o evento que ainda estava na fila; sem o vigia nunca fecha");
    }

    [Fact]
    public async Task Stream_ClosesWhenTheGuestGainsMembershipOfAnotherTv_AndLosesTheDefault()
    {
        await using var app = await TvApp.StartAsync(postgres, new TvAppOptions { WithoutTv = true });
        using var authenticator = new VirtualAuthenticator();
        await app.RegisterOwnerPasskeyAsync(authenticator);
        await app.ConfirmOwnerActionAsync(authenticator, "tv.bind-agent");
        using (var bind = await app.SendAsync(HttpMethod.Put, "/api/v1/tv/config/agent", new { agentSlug = app.Agent.Slug }))
        {
            bind.StatusCode.Should().Be(HttpStatusCode.OK);
        }

        var otherAgent = await app.PairAsync("PC Alice");
        Guid otherTvId;
        using (var create = await app.PostAsync("/api/v1/tv/tvs", new { agentSlug = otherAgent.Slug, name = "TV Alice" }))
        {
            create.StatusCode.Should().Be(HttpStatusCode.OK);
            otherTvId = (await TvApp.JsonAsync(create)).GetProperty("id").GetGuid();
        }

        var guest = await app.NewGuestAsync("Alice", ModuleOnly, 45);
        using var response = await OpenAsync(app, guest.Login.AccessToken);
        using var reader = await ReadSnapshotAsync(response);

        // A conta legada vê a padrão até ganhar a primeira filiação. A partir daí o fluxo aberto não pode continuar
        // expondo a TV padrão, mesmo que module:tv permaneça válido.
        using (var members = await app.SendAsync(HttpMethod.Put, $"/api/v1/tv/tvs/{otherTvId}/members", new { userIds = new[] { guest.UserId } }))
        {
            members.StatusCode.Should().Be(HttpStatusCode.OK);
        }

        var (frame, elapsed) = await AdvanceUntilFrameAsync(app, reader, 0);

        frame.Should().BeNull("a TV originalmente escolhida deixou de ser visível");
        elapsed.Should().BeLessThanOrEqualTo(15, "a filiação é consultada diretamente no banco no próximo vigia do fluxo");
    }

    [Fact]
    public async Task Stream_StaysOpen_WhenTheGuestLosesOnlyAnActionPermission()
    {
        await using var app = await TvApp.StartAsync(postgres);
        using var authenticator = new VirtualAuthenticator();
        await app.RegisterOwnerPasskeyAsync(authenticator);
        var guest = await app.NewGuestAsync("Alice", null, 43);
        using var response = await OpenAsync(app, guest.Login.AccessToken);
        using var reader = await ReadSnapshotAsync(response);

        (await app.ChangeGuestPermissionsAsync(authenticator, guest.UserId, ModuleOnly)).Should().Be(HttpStatusCode.OK);
        var (frame, _) = await AdvanceUntilFrameAsync(app, reader, 0);

        frame.Should().NotBeNull("o fluxo depende só de module:tv");
        frame!.Comment.Should().Be("keep-alive");
        using var off = await app.SendAsync(HttpMethod.Post, "/api/v1/tv/power/off", bearer: guest.Login.AccessToken);
        off.StatusCode.Should().Be(HttpStatusCode.Forbidden, "a permissão de ação saiu de verdade");
    }

    [Fact]
    public async Task Stream_OfTheOwner_KeepsGoing_WhateverHappensToAGuest()
    {
        await using var app = await TvApp.StartAsync(postgres);
        var guest = await app.NewGuestAsync("Alice", null, 44);
        using var ownerResponse = await OpenAsync(app, app.Login.AccessToken);
        using var ownerReader = await ReadSnapshotAsync(ownerResponse);

        using var revoke = await app.SendAsync(HttpMethod.Post, $"/api/v1/identity/guests/{guest.UserId}/revoke");
        var (frame, _) = await AdvanceUntilFrameAsync(app, ownerReader, 0);

        revoke.StatusCode.Should().Be(HttpStatusCode.NoContent);
        frame.Should().NotBeNull();
        frame!.Comment.Should().Be("keep-alive");
    }
}
