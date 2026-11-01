using System.Net;
using AwesomeAssertions;
using Microsoft.EntityFrameworkCore;
using UniOver.IntegrationTests.Identity.Passkeys;
using UniOver.IntegrationTests.Infrastructure;
using UniOver.IntegrationTests.Tv;
using UniOver.Modules.Tv.Domain;

namespace UniOver.IntegrationTests.Devices.Pairing;

/// <summary>Aprovar com "Para quem é a TV" cria, na mesma transação, a TV ligada ao computador e as filiações.</summary>
[Collection(PostgresGroup.Name)]
public sealed class ApproveWithTvTests(PostgresFixture postgres)
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static readonly DevicesAppOptions NoStepUp = new() { RequireStepUp = false };

    [Fact]
    public async Task Approve_WithMembers_CreatesTheDefaultTvBoundToTheNewAgent_WithThoseMembers()
    {
        await using var app = await DevicesApp.StartAsync(postgres, NoStepUp);
        var login = await app.LoginAsync();
        var started = await app.StartAsync("PC Raphael");
        var guest = Guid.NewGuid();

        using var response = await app.ApproveWithTvRawAsync(login, started.UserCode, [guest]);

        response.StatusCode.Should().Be(HttpStatusCode.OK);
        var slug = (await DevicesApp.JsonAsync(response)).GetProperty("slug").GetString();
        await using var tv = TvApp.CreateContext(app.Database.OwnerConnection);
        var row = await tv.Tvs.SingleAsync(Ct);
        row.AgentSlug.Should().Be(slug);
        row.Name.Should().Be("TV", "sem apelido a TV se chama só TV: o nome do computador é técnico e não vira o dela");
        row.IsDefault.Should().BeTrue();
        (await tv.TvMembers.Where(m => m.TvId == row.Id).Select(m => m.UserId).ToListAsync(Ct)).Should().Equal(guest);
    }

    [Fact]
    public async Task Approve_WithAMemberWhoLostHisTv_ClearsTheOptOutInTheSameTransaction()
    {
        await using var app = await DevicesApp.StartAsync(postgres, NoStepUp);
        var login = await app.LoginAsync();
        var returning = Guid.NewGuid();
        var untouched = Guid.NewGuid();
        await using (var seed = TvApp.CreateContext(app.Database.OwnerConnection))
        {
            seed.TvMemberOptOuts.AddRange(
                TvMemberOptOut.Create(returning, DateTimeOffset.UtcNow), TvMemberOptOut.Create(untouched, DateTimeOffset.UtcNow));
            await seed.SaveChangesAsync(Ct);
        }

        var started = await app.StartAsync("PC Raphael");
        using var response = await app.ApproveWithTvRawAsync(login, started.UserCode, [returning]);

        response.StatusCode.Should().Be(HttpStatusCode.OK);
        await using var tv = TvApp.CreateContext(app.Database.OwnerConnection);
        (await tv.TvMembers.Select(m => m.UserId).ToListAsync(Ct)).Should().Equal(returning);
        (await tv.TvMemberOptOuts.Select(o => o.UserId).ToListAsync(Ct)).Should().Equal(untouched);
    }

    [Fact]
    public async Task Approve_WithAnEmptyList_CreatesTheTvOnlyForTheOwner_AndUsesTheTvNameWhenGiven()
    {
        await using var app = await DevicesApp.StartAsync(postgres, NoStepUp);
        var login = await app.LoginAsync();
        var first = await app.StartAsync("PC Casa");
        (await app.ApproveWithTvRawAsync(login, first.UserCode, [])).StatusCode.Should().Be(HttpStatusCode.OK);
        var second = await app.StartAsync("PC Sala");

        using var response = await app.ApproveWithTvRawAsync(login, second.UserCode, [Guid.NewGuid()], tvName: "TV de Ana");

        response.StatusCode.Should().Be(HttpStatusCode.OK);
        await using var tv = TvApp.CreateContext(app.Database.OwnerConnection);
        var tvs = await tv.Tvs.OrderBy(t => t.CreatedAt).ToListAsync(Ct);
        tvs.Should().HaveCount(2);
        tvs[0].IsDefault.Should().BeTrue();
        (await tv.TvMembers.CountAsync(m => m.TvId == tvs[0].Id, Ct)).Should().Be(0);
        tvs[1].IsDefault.Should().BeFalse();
        tvs[1].Name.Should().Be("TV de Ana");
    }

    [Fact]
    public async Task Approve_WithoutTheMemberList_StillCreatesTheTvOnlyForTheOwner()
    {
        await using var app = await DevicesApp.StartAsync(postgres, NoStepUp);
        var login = await app.LoginAsync();
        var started = await app.StartAsync("PC Casa");

        using var response = await app.ApproveRawAsync(login, started.UserCode);

        response.StatusCode.Should().Be(HttpStatusCode.OK);
        var slug = (await DevicesApp.JsonAsync(response)).GetProperty("slug").GetString();
        await using var tv = TvApp.CreateContext(app.Database.OwnerConnection);
        var row = await tv.Tvs.SingleAsync(Ct);
        row.AgentSlug.Should().Be(slug);
        (await tv.TvMembers.CountAsync(Ct)).Should().Be(0);
    }

    [Fact]
    public async Task Approve_WithRepeatedMembers_Returns400_AndCreatesNothing()
    {
        await using var app = await DevicesApp.StartAsync(postgres, NoStepUp);
        var login = await app.LoginAsync();
        var started = await app.StartAsync();
        var guest = Guid.NewGuid();

        using var response = await app.ApproveWithTvRawAsync(login, started.UserCode, [guest, guest]);

        response.StatusCode.Should().Be(HttpStatusCode.BadRequest);
        await using var db = app.Db();
        (await db.Agents.CountAsync(Ct)).Should().Be(0);
        await using var tv = TvApp.CreateContext(app.Database.OwnerConnection);
        (await tv.Tvs.CountAsync(Ct)).Should().Be(0);
    }

    [Fact]
    public async Task Approve_WhenTheTvCannotBeSaved_RollsBackTheAgentAndThePairing()
    {
        await using var app = await DevicesApp.StartAsync(postgres, NoStepUp);
        var login = await app.LoginAsync();
        var started = await app.StartAsync("PC Casa");
        await using (var tv = TvApp.CreateContext(app.Database.OwnerConnection))
        {
            // Já existe uma TV usando o slug que o computador receberia: a gravação do lado da TV falha.
            tv.Tvs.Add(ConfiguredTv.Create("Outra", "pc-casa", isDefault: true, Guid.NewGuid(), DateTimeOffset.UtcNow));
            await tv.SaveChangesAsync(Ct);
        }

        using var response = await app.ApproveWithTvRawAsync(login, started.UserCode, []);

        response.StatusCode.Should().Be(HttpStatusCode.InternalServerError);
        await using var db = app.Db();
        (await db.Agents.CountAsync(Ct)).Should().Be(0);
        (await db.Pairings.SingleAsync(Ct)).ApprovedAt.Should().BeNull();
    }

    [Fact]
    public async Task Approve_WithMembers_StillAsksForTheTvBindingConfirmation()
    {
        await using var app = await DevicesApp.StartAsync(postgres);
        using var authenticator = new VirtualAuthenticator();
        var login = await app.LoginAsync();
        await app.RegisterPasskeyAsync(login, authenticator);
        var started = await app.StartAsync();

        using var without = await app.ApproveWithTvRawAsync(login, started.UserCode, []);
        without.StatusCode.Should().Be(HttpStatusCode.Forbidden);
        (await DevicesApp.JsonAsync(without)).GetProperty("action").GetString().Should().Be("tv.bind-agent");

        await app.ConfirmApproveAsync(login, authenticator);
        using var confirmed = await app.ApproveWithTvRawAsync(login, started.UserCode, []);
        confirmed.StatusCode.Should().Be(HttpStatusCode.OK);
    }
}
