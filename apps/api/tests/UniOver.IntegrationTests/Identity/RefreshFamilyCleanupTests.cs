using AwesomeAssertions;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Npgsql;
using NpgsqlTypes;
using UniOver.BuildingBlocks.Persistence;
using UniOver.IntegrationTests.Infrastructure;
using UniOver.Modules.Identity.Features.Refresh;

namespace UniOver.IntegrationTests.Identity;

/// <summary>
/// A limpeza apaga a família de refresh INTEIRA quando ela morreu (último token vencido ou todos revogados, há mais de 7
/// dias) e nunca mexe numa família viva nem num token solto: o token já usado de uma família viva é a prova do reuso.
/// Roda com o papel da aplicação (sem DDL) para provar que o DELETE é permitido a ele.
/// </summary>
[Collection(PostgresGroup.Name)]
public sealed class RefreshFamilyCleanupTests(PostgresFixture postgres)
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    [Fact]
    public async Task DeletesOnlyWholeDeadFamilies_AndLeavesLiveAndRecentOnesUntouched()
    {
        await using var app = await IdentityApp.StartAsync(postgres);
        var live = await app.LoginAsync();
        var now = app.Time.GetUtcNow();
        var userId = await UserIdAsync(app);

        // Morta por vencimento: três tokens (dois já girados), o último venceu há 30 dias.
        var expired = Guid.NewGuid();
        await InsertAsync(app, userId, expired, createdAgo: 120, expiresIn: -110, usedAgo: 119);
        await InsertAsync(app, userId, expired, createdAgo: 119, expiresIn: -100, usedAgo: 118);
        await InsertAsync(app, userId, expired, createdAgo: 118, expiresIn: -30);

        // Morta por revogação: todos os tokens revogados há 10 dias.
        var revoked = Guid.NewGuid();
        await InsertAsync(app, userId, revoked, createdAgo: 40, expiresIn: 30, usedAgo: 39, revokedAgo: 10);
        await InsertAsync(app, userId, revoked, createdAgo: 39, expiresIn: 30, revokedAgo: 10);

        // Vencida há 3 dias: ainda dentro da guarda de 7, fica.
        var recentlyExpired = Guid.NewGuid();
        await InsertAsync(app, userId, recentlyExpired, createdAgo: 20, expiresIn: -3);

        // Revogada há 2 dias: fica (a prova do reuso vale mais alguns dias).
        var recentlyRevoked = Guid.NewGuid();
        await InsertAsync(app, userId, recentlyRevoked, createdAgo: 20, expiresIn: 30, revokedAgo: 2);

        // Revogada pela metade: um token vivo, mesmo com o resto revogado há muito tempo, mantém a família.
        var partlyRevoked = Guid.NewGuid();
        await InsertAsync(app, userId, partlyRevoked, createdAgo: 40, expiresIn: 30, usedAgo: 39, revokedAgo: 30);
        await InsertAsync(app, userId, partlyRevoked, createdAgo: 39, expiresIn: 30);

        var before = await CountByFamilyAsync(app);

        await using var runtime = IdentityApp.CreateContext(app.Database.RuntimeConnection);
        var removed = await RefreshFamilyCleanup.RunAsync(runtime, app.Time, Ct);

        removed.Should().Be(5);
        var after = await CountByFamilyAsync(app);
        after.Keys.Should().NotContain([expired, revoked]);
        after[recentlyExpired].Should().Be(before[recentlyExpired]);
        after[recentlyRevoked].Should().Be(before[recentlyRevoked]);
        after[partlyRevoked].Should().Be(2, "o token vivo salva a família inteira, inclusive os já usados");
        after.Values.Sum().Should().Be(before.Values.Sum() - 5);

        // A sessão de verdade segue renovando depois da limpeza.
        app.Time.Advance(TimeSpan.FromMinutes(1));
        (await app.RefreshRawAsync(live.RefreshSecret)).StatusCode.Should().Be(System.Net.HttpStatusCode.OK);
        _ = now;
    }

    [Fact]
    public async Task TheDailyRetentionServiceRunsIt_WithoutANewTimer()
    {
        await using var app = await IdentityApp.StartAsync(postgres);
        var userId = await UserIdAsync(app);
        var dead = Guid.NewGuid();
        await InsertAsync(app, userId, dead, createdAgo: 200, expiresIn: -100);

        var results = await app.Services.GetRequiredService<AuditPurgeService>().RunOnceAsync(Ct);

        results.Should().Contain(r => r.Name == RefreshFamilyCleanup.JobName && r.Removed == 1 && r.Succeeded);
        (await CountByFamilyAsync(app)).Keys.Should().NotContain(dead);
    }

    private static async Task<Guid> UserIdAsync(IdentityApp app)
    {
        await using var db = app.Db();
        return await db.Users.Select(u => u.Id).SingleAsync(Ct);
    }

    private static async Task<Dictionary<Guid, int>> CountByFamilyAsync(IdentityApp app)
    {
        await using var db = app.Db();
        var rows = await db.RefreshTokens.GroupBy(t => t.FamilyId).Select(g => new { g.Key, Count = g.Count() }).ToListAsync(Ct);
        return rows.ToDictionary(r => r.Key, r => r.Count);
    }

    private static async Task InsertAsync(
        IdentityApp app, Guid userId, Guid family, int createdAgo, int expiresIn, int? usedAgo = null, int? revokedAgo = null)
    {
        var now = app.Time.GetUtcNow();
        await using var connection = new NpgsqlConnection(app.Database.OwnerConnection);
        await connection.OpenAsync(Ct);
        await using var command = new NpgsqlCommand(
            "INSERT INTO identity.refresh_tokens (id, user_id, family_id, token_hash, created_at, expires_at, used_at, revoked_at, revoked_reason) "
            + "VALUES (@id, @user, @family, @hash, @created, @expires, @used, @revoked, @reason)",
            connection);
        command.Parameters.AddWithValue("id", Guid.NewGuid());
        command.Parameters.AddWithValue("user", userId);
        command.Parameters.AddWithValue("family", family);
        command.Parameters.Add(new NpgsqlParameter("hash", NpgsqlDbType.Bytea) { Value = Guid.NewGuid().ToByteArray() });
        command.Parameters.AddWithValue("created", now.AddDays(-createdAgo));
        command.Parameters.AddWithValue("expires", now.AddDays(expiresIn));
        command.Parameters.Add(new NpgsqlParameter("used", NpgsqlDbType.TimestampTz) { Value = usedAgo is { } u ? now.AddDays(-u) : DBNull.Value });
        command.Parameters.Add(new NpgsqlParameter("revoked", NpgsqlDbType.TimestampTz) { Value = revokedAgo is { } r ? now.AddDays(-r) : DBNull.Value });
        command.Parameters.Add(new NpgsqlParameter("reason", NpgsqlDbType.Varchar) { Value = revokedAgo is null ? DBNull.Value : "logout" });
        await command.ExecuteNonQueryAsync(Ct);
    }
}
