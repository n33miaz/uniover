using AwesomeAssertions;
using Microsoft.EntityFrameworkCore;
using Npgsql;

namespace UniOver.IntegrationTests.Identity;

/// <summary>Segura toda rotação de refresh dentro do UPDATE de used_at (2 s) para outra operação chegar com o sucessor ainda por inserir.</summary>
internal static class RotationHold
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    /// <summary>Segura toda rotação dentro do UPDATE de used_at (2 s) para a outra operação chegar com o sucessor ainda por inserir.</summary>
    public static async Task InstallAsync(IdentityApp app)
    {
        await using var db = app.Db();
        await db.Database.ExecuteSqlRawAsync(
            """
            CREATE FUNCTION identity.delay_refresh_rotation() RETURNS trigger
            LANGUAGE plpgsql AS $body$
            BEGIN
                IF OLD.used_at IS NULL AND NEW.used_at IS NOT NULL THEN
                    PERFORM pg_sleep(2);
                END IF;
                RETURN NEW;
            END
            $body$;
            """, Ct);
        await db.Database.ExecuteSqlRawAsync(
            """
            CREATE TRIGGER delay_refresh_rotation
            BEFORE UPDATE OF used_at ON identity.refresh_tokens
            FOR EACH ROW EXECUTE FUNCTION identity.delay_refresh_rotation();
            """, Ct);
    }

    public static async Task WaitUntilPausedAsync(IdentityApp app)
    {
        await using var observer = new NpgsqlConnection(app.Database.RuntimeConnection);
        await observer.OpenAsync(Ct);
        var paused = false;
        var deadline = DateTimeOffset.UtcNow.AddSeconds(10);
        while (!paused && DateTimeOffset.UtcNow < deadline)
        {
            await using var command = new NpgsqlCommand(
                "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE pid <> pg_backend_pid() AND datname = current_database() AND state = 'active' AND wait_event = 'PgSleep')",
                observer);
            paused = (bool)(await command.ExecuteScalarAsync(Ct))!;
            if (!paused)
            {
                await Task.Delay(TimeSpan.FromMilliseconds(20), Ct);
            }
        }

        paused.Should().BeTrue("a rotação precisa estar parada antes de inserir o sucessor");
    }
}
