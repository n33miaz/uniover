using System.Net;
using AwesomeAssertions;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using UniOver.IntegrationTests.Infrastructure;
using UniOver.Modules.Identity.Domain;
using UniOver.Modules.Identity.Security;

namespace UniOver.IntegrationTests.Identity;

/// <summary>
/// A falha de senha é contada pelo banco, num único UPDATE. Antes cada tentativa somava um em memória e gravava de volta:
/// tentativas paralelas liam o mesmo valor, contavam a menos e atrasavam o bloqueio progressivo.
/// </summary>
[Collection(PostgresGroup.Name)]
public sealed class FailedLoginCounterTests(PostgresFixture postgres)
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    [Fact]
    public async Task ParallelWrongPasswords_AreAllCounted()
    {
        await using var app = await IdentityApp.StartAsync(postgres);

        // Quatro tentativas, uma a menos que o limiar do bloqueio: nenhuma pode ver a conta já bloqueada, então todas passam pela
        // verificação da senha ao mesmo tempo (o hash leva dezenas de ms). Com a soma em memória cada uma lia 0 e gravava 1.
        const int attempts = 4;
        var responses = await Task.WhenAll(Enumerable.Range(0, attempts)
            .Select(_ => app.LoginRawAsync(app.OwnerEmail, "errada-errada")));
        foreach (var response in responses)
        {
            response.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
            response.Dispose();
        }

        await using var db = app.Db();
        var owner = await db.Users.AsNoTracking().SingleAsync(Ct);
        owner.FailedLoginCount.Should().Be(attempts);
        owner.LockoutUntil.Should().BeNull();

        // A quinta falha, já em fila, cruza o limiar e bloqueia.
        using var fifth = await app.LoginRawAsync(app.OwnerEmail, "errada-errada");
        fifth.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
        var locked = await ReadAsync(app);
        locked.FailedLoginCount.Should().Be(5);
        locked.IsLockedOut(app.Time.GetUtcNow()).Should().BeTrue();
    }

    [Fact]
    public async Task TheLockoutStartsAtTheThreshold_AndGrows()
    {
        await using var app = await IdentityApp.StartAsync(postgres);
        var now = app.Time.GetUtcNow();
        var owner = await OwnerIdAsync(app);

        for (var i = 0; i < 4; i++)
        {
            await RegisterAsync(app, owner, now, LockoutPolicy.Default);
        }

        (await ReadAsync(app)).LockoutUntil.Should().BeNull("abaixo do limiar não bloqueia");

        await RegisterAsync(app, owner, now, LockoutPolicy.Default);
        var fifth = await ReadAsync(app);
        fifth.FailedLoginCount.Should().Be(5);
        fifth.LockoutUntil.Should().Be(now + TimeSpan.FromMinutes(1));
        fifth.LastFailedAt.Should().Be(now);

        await RegisterAsync(app, owner, now.AddMinutes(1), LockoutPolicy.Default);
        (await ReadAsync(app)).LockoutUntil.Should().Be(now.AddMinutes(1) + TimeSpan.FromMinutes(2));
    }

    [Fact]
    public async Task TheLockoutNeverShrinks_EvenWhenALaterCallComputesAShorterOne()
    {
        await using var app = await IdentityApp.StartAsync(postgres);
        var now = app.Time.GetUtcNow();
        var owner = await OwnerIdAsync(app);
        for (var i = 0; i < 6; i++)
        {
            await RegisterAsync(app, owner, now, LockoutPolicy.Default);
        }

        var before = (await ReadAsync(app)).LockoutUntil;
        before.Should().Be(now + TimeSpan.FromMinutes(2));

        // Uma tentativa que chega depois e calcula um bloqueio menor (política curta) não encurta o que já valia.
        await RegisterAsync(app, owner, now, new LockoutPolicy(5, TimeSpan.FromSeconds(1), TimeSpan.FromSeconds(1)));

        (await ReadAsync(app)).LockoutUntil.Should().Be(before);
    }

    private static async Task<Guid> OwnerIdAsync(IdentityApp app)
    {
        await using var db = app.Db();
        return await db.Users.Select(u => u.Id).SingleAsync(Ct);
    }

    private static async Task<User> ReadAsync(IdentityApp app)
    {
        await using var db = app.Db();
        return await db.Users.AsNoTracking().SingleAsync(Ct);
    }

    private static async Task RegisterAsync(IdentityApp app, Guid userId, DateTimeOffset now, LockoutPolicy policy)
    {
        await using var scope = app.Services.CreateAsyncScope();
        await scope.ServiceProvider.GetRequiredService<FailedLoginCounter>().RegisterAsync(userId, now, policy, Ct);
    }
}
