using System.Collections.Concurrent;
using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using AwesomeAssertions;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Npgsql;
using UniOver.IntegrationTests.Identity;
using UniOver.IntegrationTests.Infrastructure;
using UniOver.IntegrationTests.Training;
using UniOver.Modules.Training.Domain.Foods;
using UniOver.Modules.Training.Persistence;
using UniOver.Modules.Training.Ports.Foods;

namespace UniOver.IntegrationTests.Training.Foods;

[Collection(PostgresGroup.Name)]
public sealed class FoodEndpointsTests(PostgresFixture postgres)
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    [Fact]
    public async Task OpenFoodFacts_WithoutContact_Returns503AndDoesNotCallClient()
    {
        var off = new FakeOff();
        await using var app = await TrainingApp.StartAsync(postgres, new TrainingAppOptions { Off = off });
        var owner = await app.LoginAsync();

        using var search = await app.SendAsync(HttpMethod.Get, "/api/v1/training/foods/off/search?q=arroz", bearer: owner.AccessToken);
        using var lookup = await app.SendAsync(HttpMethod.Get, "/api/v1/training/foods/off/barcode/12345678", bearer: owner.AccessToken);

        search.StatusCode.Should().Be(HttpStatusCode.ServiceUnavailable);
        (await TrainingApp.JsonAsync(search)).GetProperty("type").GetString().Should().EndWith("off-not-configured");
        lookup.StatusCode.Should().Be(HttpStatusCode.ServiceUnavailable);
        off.SearchCalls.Should().Be(0);
        off.LookupCalls.Should().Be(0);
    }

    [Fact]
    public async Task OpenFoodFacts_SearchCachesProducts_AndRepeatedBarcodeLookupIsLocal()
    {
        var off = new FakeOff();
        await using var app = await TrainingApp.StartAsync(postgres, new TrainingAppOptions { Off = off, OffContact = "foods@uniover.test" });
        var owner = await app.LoginAsync();

        using var search = await app.SendAsync(HttpMethod.Get, "/api/v1/training/foods/off/search?q=arroz", bearer: owner.AccessToken);
        search.StatusCode.Should().Be(HttpStatusCode.OK);
        var items = (await TrainingApp.JsonAsync(search)).EnumerateArray().ToArray();
        items.Should().ContainSingle();
        items[0].GetProperty("attribution").GetString().Should().Be("Open Food Facts, ODbL");
        off.SearchCalls.Should().Be(1);

        using var first = await app.SendAsync(HttpMethod.Get, "/api/v1/training/foods/off/barcode/12345678", bearer: owner.AccessToken);
        using var second = await app.SendAsync(HttpMethod.Get, "/api/v1/training/foods/off/barcode/12345678", bearer: owner.AccessToken);
        first.StatusCode.Should().Be(HttpStatusCode.OK);
        second.StatusCode.Should().Be(HttpStatusCode.OK);
        off.LookupCalls.Should().Be(0, "a search already populated the shared foods cache");

        using var db = TrainingApp.CreateContext(app.Database.RuntimeConnection);
        (await db.Set<Food>().CountAsync(f => f.Source == FoodSources.Off, Ct)).Should().Be(1);
    }

    [Fact]
    public async Task OpenFoodFacts_ConcurrentSearchesUpdatingSameCachedProductDoNotFail()
    {
        var off = new FakeOff();
        await using var app = await TrainingApp.StartAsync(postgres,
            new TrainingAppOptions { Off = off, OffContact = "foods@uniover.test", FakeClock = true });
        var owner = await app.LoginAsync();

        using (var seed = await app.SendAsync(HttpMethod.Get, "/api/v1/training/foods/off/search?q=arroz", bearer: owner.AccessToken))
            seed.StatusCode.Should().Be(HttpStatusCode.OK);
        app.Time!.Advance(TimeSpan.FromSeconds(1));

        var searches = Enumerable.Range(0, 7)
            .Select(_ => app.SendAsync(HttpMethod.Get, "/api/v1/training/foods/off/search?q=arroz", bearer: owner.AccessToken))
            .ToArray();
        var responses = await Task.WhenAll(searches);
        try { responses.Should().OnlyContain(response => response.StatusCode == HttpStatusCode.OK); }
        finally { foreach (var response in responses) response.Dispose(); }

        using var db = TrainingApp.CreateContext(app.Database.RuntimeConnection);
        (await db.Set<Food>().CountAsync(f => f.Source == FoodSources.Off && f.SourceRef == "12345678", Ct)).Should().Be(1);
    }

    [Fact]
    public async Task OpenFoodFacts_ValidatesInputs_DegradesFailures_AndAppliesItsOwnRateLimit()
    {
        var off = new FakeOff { Search = (_, _) => throw new HttpRequestException("upstream down") };
        await using var app = await TrainingApp.StartAsync(postgres, new TrainingAppOptions
        {
            Off = off,
            OffContact = "foods@uniover.test",
            FakeClock = true,
        });
        var owner = await app.LoginAsync();
        using var invalidSearch = await app.SendAsync(HttpMethod.Get, "/api/v1/training/foods/off/search?q=x", bearer: owner.AccessToken);
        using var invalidBarcode = await app.SendAsync(HttpMethod.Get, "/api/v1/training/foods/off/barcode/123", bearer: owner.AccessToken);
        invalidSearch.StatusCode.Should().Be(HttpStatusCode.BadRequest);
        invalidBarcode.StatusCode.Should().Be(HttpStatusCode.BadRequest);

        using var failed = await app.SendAsync(HttpMethod.Get, "/api/v1/training/foods/off/search?q=arroz", bearer: owner.AccessToken);
        failed.StatusCode.Should().Be(HttpStatusCode.BadGateway);
        failed.Headers.RetryAfter.Should().NotBeNull();
        (await TrainingApp.JsonAsync(failed)).GetProperty("type").GetString().Should().EndWith("upstream-unavailable");

        off.Search = (_, _) => Task.FromResult(new OffSearchPage([]));
        for (var i = 0; i < 7; i++)
        {
            using var ok = await app.SendAsync(HttpMethod.Get, $"/api/v1/training/foods/off/search?q=rice{i}", bearer: owner.AccessToken);
            ok.StatusCode.Should().Be(HttpStatusCode.OK);
        }
        using var limited = await app.SendAsync(HttpMethod.Get, "/api/v1/training/foods/off/search?q=rice-last", bearer: owner.AccessToken);
        limited.StatusCode.Should().Be(HttpStatusCode.TooManyRequests);
        limited.Headers.RetryAfter.Should().NotBeNull();
        (await TrainingApp.JsonAsync(limited)).GetProperty("type").GetString().Should().EndWith("upstream-unavailable");
        off.SearchCalls.Should().Be(8, "one failed request and seven successful requests consume the eight-call window");
    }

    [Fact]
    public async Task TacoImport_IsOwnerOnlyIdempotentAndContinuesAfterInvalidRows()
    {
        const string csv = "code,name,kcal_100g,protein_g,carb_g,fat_g\nsynthetic-1,Alimento sintético,100,5,20,2\nsynthetic-2,Linha inválida,n/a,0,0,0\n";
        await using var app = await TrainingApp.StartAsync(postgres);
        var owner = await app.LoginAsync();
        var guest = await app.NewGuestAsync("food-catalog-reader", [TrainingPermissionMap.Module], 17);
        using (var denied = await TacoImportAsync(app, guest.Login.AccessToken, Guid.NewGuid(), csv))
            denied.StatusCode.Should().Be(HttpStatusCode.Forbidden);
        var key = Guid.NewGuid();

        using var first = await TacoImportAsync(app, owner.AccessToken, key, csv);
        using var replay = await TacoImportAsync(app, owner.AccessToken, key, csv);
        first.StatusCode.Should().Be(HttpStatusCode.OK);
        replay.StatusCode.Should().Be(HttpStatusCode.OK);
        var body = await TrainingApp.JsonAsync(first);
        body.GetProperty("imported").GetInt32().Should().Be(1);
        body.GetProperty("invalidRows").EnumerateArray().Select(x => x.GetInt32()).Should().Equal(3);
        replay.Headers.GetValues("Idempotent-Replayed").Should().Contain("true");

        using var db = TrainingApp.CreateContext(app.Database.RuntimeConnection);
        (await db.Set<Food>().CountAsync(f => f.Source == FoodSources.Taco, Ct)).Should().Be(1);
        var imported = await db.Set<Food>().SingleAsync(f => f.Source == FoodSources.Taco, Ct);
        imported.OwnerUserId.Should().BeNull("TACO catalog rows are global, not private foods");
        imported.Attribution.Should().Be("Arquivo CSV fornecido pelo proprietário; origem/licença não verificadas pelo UniOver");
    }

    [Fact]
    public async Task OwnFoodsArePrivateAndCannotBeReferencedOrChangedByAnotherTrainingAccount()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var ownerA = await app.LoginAsync();
        var accountB = await app.NewGuestAsync("food-account-b", [TrainingPermissionMap.Module], 18);
        var foodId = Guid.CreateVersion7();
        var now = DateTimeOffset.UtcNow;

        using (var create = await app.SendAsync(HttpMethod.Put, $"/api/v1/training/foods/{foodId}", new
        {
            name = "Privado da conta A",
            kcalPer100g = 100m,
            proteinPer100g = 5m,
            carbsPer100g = 20m,
            fatPer100g = 2m,
            clientUpdatedAt = now,
        }, ownerA.AccessToken, Guid.NewGuid())) create.StatusCode.Should().Be(HttpStatusCode.OK);

        using var pull = await app.SendAsync(HttpMethod.Get, "/api/v1/training/foods", bearer: accountB.Login.AccessToken);
        pull.StatusCode.Should().Be(HttpStatusCode.OK);
        (await TrainingApp.JsonAsync(pull)).GetProperty("items").EnumerateArray()
            .Should().NotContain(item => item.GetProperty("id").GetGuid() == foodId);

        using (var update = await app.SendAsync(HttpMethod.Put, $"/api/v1/training/foods/{foodId}", new
        {
            name = "Tentativa da conta B",
            kcalPer100g = 999m,
            proteinPer100g = 9m,
            carbsPer100g = 9m,
            fatPer100g = 9m,
            clientUpdatedAt = now.AddMinutes(1),
        }, accountB.Login.AccessToken, Guid.NewGuid())) update.StatusCode.Should().Be(HttpStatusCode.Forbidden);

        using (var meal = await app.SendAsync(HttpMethod.Put, $"/api/v1/training/meals/{Guid.CreateVersion7()}", new
        {
            foodId,
            eatenOn = DateOnly.FromDateTime(DateTime.UtcNow),
            mealType = "lunch",
            name = "Privado da conta A",
            quantityG = 100m,
            kcal = 100m,
            proteinG = 5m,
            carbG = 20m,
            fatG = 2m,
            clientUpdatedAt = now.AddMinutes(2),
        }, accountB.Login.AccessToken, Guid.NewGuid())) meal.StatusCode.Should().Be(HttpStatusCode.NotFound);

        using var db = TrainingApp.CreateContext(app.Database.RuntimeConnection);
        (await db.Set<Food>().SingleAsync(f => f.Id == foodId, Ct)).Name.Should().Be("Privado da conta A");
        (await db.Set<MealEntry>().CountAsync(e => e.FoodId == foodId, Ct)).Should().Be(0);
    }

    [Fact]
    public async Task TacoImport_ConcurrentFilesDoNotCreateDuplicateSourceRows()
    {
        const string csv = "code,name,kcal_100g,protein_g,carb_g,fat_g\nsynthetic-concurrent,Alimento sintético,100,5,20,2\n";
        await using var app = await TrainingApp.StartAsync(postgres);
        var owner = await app.LoginAsync();

        var requests = Enumerable.Range(0, 2)
            .Select(_ => TacoImportAsync(app, owner.AccessToken, Guid.NewGuid(), csv))
            .ToArray();
        var responses = await Task.WhenAll(requests);
        try { responses.Should().OnlyContain(response => response.StatusCode == HttpStatusCode.OK); }
        finally { foreach (var response in responses) response.Dispose(); }

        using var db = TrainingApp.CreateContext(app.Database.RuntimeConnection);
        (await db.Set<Food>().CountAsync(f => f.Source == FoodSources.Taco && f.SourceRef == "synthetic-concurrent", Ct)).Should().Be(1);
    }

    [Fact]
    public async Task TacoImport_RefusesFilesOverOneMiB()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var owner = await app.LoginAsync();
        using var response = await TacoImportAsync(app, owner.AccessToken, Guid.NewGuid(), new string('a', 1_000_001));
        response.StatusCode.Should().Be(HttpStatusCode.RequestEntityTooLarge, "response was {0}", await response.Content.ReadAsStringAsync(Ct));
    }

    [Fact]
    public async Task SameMealIdUnderFiftyConcurrentWritesProducesOneRow_AndSnapshotSurvivesFoodChanges()
    {
        await using var app = await TrainingApp.StartAsync(postgres);
        var owner = await app.LoginAsync();
        var foodId = Guid.CreateVersion7();
        var now = DateTimeOffset.UtcNow;
        using (var food = await app.SendAsync(HttpMethod.Put, $"/api/v1/training/foods/{foodId}", new
        {
            name = "Alimento próprio",
            kcalPer100g = 100m,
            proteinPer100g = 5m,
            carbsPer100g = 20m,
            fatPer100g = 2m,
            clientUpdatedAt = now,
        }, owner.AccessToken, Guid.NewGuid())) food.StatusCode.Should().Be(HttpStatusCode.OK);

        var mealId = Guid.CreateVersion7();
        var mealTime = now.AddSeconds(1);
        var body = new
        {
            foodId,
            eatenOn = DateOnly.FromDateTime(DateTime.UtcNow),
            mealType = "lunch",
            name = "Alimento próprio",
            quantityG = 150m,
            kcal = 150m,
            proteinG = 7.5m,
            carbG = 30m,
            fatG = 3m,
            clientUpdatedAt = mealTime,
        };
        var puts = Enumerable.Range(0, 50).Select(_ => app.SendAsync(HttpMethod.Put, $"/api/v1/training/meals/{mealId}", body, owner.AccessToken, Guid.NewGuid())).ToArray();
        var responses = await Task.WhenAll(puts);
        try { responses.Should().OnlyContain(r => r.StatusCode == HttpStatusCode.OK); }
        finally { foreach (var response in responses) response.Dispose(); }

        using (var change = await app.SendAsync(HttpMethod.Put, $"/api/v1/training/foods/{foodId}", new
        {
            name = "Alimento próprio",
            kcalPer100g = 900m,
            proteinPer100g = 9m,
            carbsPer100g = 2m,
            fatPer100g = 40m,
            clientUpdatedAt = now.AddMinutes(1),
        }, owner.AccessToken, Guid.NewGuid())) change.StatusCode.Should().Be(HttpStatusCode.OK);

        using var db = TrainingApp.CreateContext(app.Database.RuntimeConnection);
        (await db.Set<MealEntry>().CountAsync(e => e.Id == mealId, Ct)).Should().Be(1);
        (await db.Set<MealEntry>().SingleAsync(e => e.Id == mealId, Ct)).Kcal.Should().Be(150m);
    }

    [Fact]
    public async Task FoodsMigrationAddsOnlyItsTablesAndRuntimeRoleCanUseThem()
    {
        await using (var fresh = await TrainingApp.StartAsync(postgres))
        await using (var training = TrainingApp.CreateContext(fresh.Database.OwnerConnection))
        {
            (await training.Database.GetPendingMigrationsAsync(Ct)).Should().BeEmpty();
            (await training.Database.GetAppliedMigrationsAsync(Ct)).Should().Contain("20261022124339_AddFoods");
            await training.Database.MigrateAsync(Ct);
            (await training.Database.GetPendingMigrationsAsync(Ct)).Should().BeEmpty();
        }

        await using var app = await TrainingApp.StartAsync(postgres, new TrainingAppOptions { MigrateTraining = false });
        await using (var training = TrainingApp.CreateContext(app.Database.OwnerConnection))
        {
            await training.Database.MigrateAsync("20261022120000_AddIdempotencyGeneration", Ct);
            var tablesBefore = await GetTrainingTablesAsync(app.Database.OwnerConnection);
            var existingSchemaBefore = await GetExistingTrainingSchemaObjectsAsync(app.Database.OwnerConnection);
            var pending = await training.Database.GetPendingMigrationsAsync(Ct);
            // Migrações posteriores (o programa da semana) vêm depois e têm o teste delas; aqui só a AddFoods é aplicada.
            pending.Should().StartWith("20261022124339_AddFoods");
            await training.Database.MigrateAsync("20261022124339_AddFoods", Ct);
            (await training.Database.GetAppliedMigrationsAsync(Ct)).Should().Contain("20261022124339_AddFoods");
            (await training.Database.GetPendingMigrationsAsync(Ct)).Should().NotContain("20261022124339_AddFoods");
            (await GetTrainingTablesAsync(app.Database.OwnerConnection)).Except(tablesBefore)
                .Should().BeEquivalentTo("foods", "meal_entries");
            (await GetExistingTrainingSchemaObjectsAsync(app.Database.OwnerConnection)).Should().BeEquivalentTo(existingSchemaBefore,
                "AddFoods must not alter columns, constraints, or indexes on existing Training tables");
        }

        await using var connection = new NpgsqlConnection(app.Database.RuntimeConnection);
        await connection.OpenAsync(Ct);
        await using (var insert = new NpgsqlCommand("INSERT INTO training.foods (id, source, owner_user_id, name, kcal_100g, protein_100g, carb_100g, fat_100g, created_at, updated_at, client_updated_at) VALUES (gen_random_uuid(), 'own', gen_random_uuid(), 'runtime', 10, 1, 2, 3, now(), now(), now())", connection))
            (await insert.ExecuteNonQueryAsync(Ct)).Should().Be(1);
        await using (var insert = new NpgsqlCommand("INSERT INTO training.meal_entries (id, user_id, eaten_on, meal_type, name, quantity_g, kcal, protein_g, carb_g, fat_g, created_at, updated_at, client_updated_at) VALUES (gen_random_uuid(), gen_random_uuid(), current_date, 'lunch', 'runtime', 100, 10, 1, 2, 3, now(), now(), now())", connection))
            (await insert.ExecuteNonQueryAsync(Ct)).Should().Be(1);
        await using var ddl = new NpgsqlCommand("CREATE TABLE training.foods_intruder (id int)", connection);
        var denied = await Assert.ThrowsAsync<PostgresException>(() => ddl.ExecuteNonQueryAsync(Ct));
        denied.SqlState.Should().Be("42501");
    }

    private static async Task<HttpResponseMessage> TacoImportAsync(TrainingApp app, string token, Guid key, string csv)
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, "/api/v1/training/foods/imports/taco");
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        request.Headers.Add("Idempotency-Key", key.ToString());
        request.Content = new StringContent(csv, Encoding.UTF8, "text/csv");
        return await app.Client.SendAsync(request, Ct);
    }

    private static async Task<HashSet<string>> GetTrainingTablesAsync(string connectionString)
    {
        await using var connection = new NpgsqlConnection(connectionString);
        await connection.OpenAsync(Ct);
        await using var command = new NpgsqlCommand(
            "SELECT table_name FROM information_schema.tables WHERE table_schema = 'training' AND table_type = 'BASE TABLE'", connection);
        await using var reader = await command.ExecuteReaderAsync(Ct);
        var tables = new HashSet<string>(StringComparer.Ordinal);
        while (await reader.ReadAsync(Ct)) tables.Add(reader.GetString(0));
        return tables;
    }

    private static async Task<string[]> GetExistingTrainingSchemaObjectsAsync(string connectionString)
    {
        await using var connection = new NpgsqlConnection(connectionString);
        await connection.OpenAsync(Ct);
        await using var command = new NpgsqlCommand(
            """
            SELECT 'column:' || table_name || ':' || ordinal_position || ':' || column_name || ':' || data_type || ':' || is_nullable || ':' || COALESCE(column_default, '')
            FROM information_schema.columns
            WHERE table_schema = 'training' AND table_name NOT IN ('foods', 'meal_entries')
            UNION ALL
            SELECT 'constraint:' || cl.relname || ':' || c.conname || ':' || pg_get_constraintdef(c.oid)
            FROM pg_constraint c
            JOIN pg_class cl ON cl.oid = c.conrelid
            JOIN pg_namespace n ON n.oid = cl.relnamespace
            WHERE n.nspname = 'training' AND cl.relname NOT IN ('foods', 'meal_entries')
            UNION ALL
            SELECT 'index:' || tablename || ':' || indexname || ':' || indexdef
            FROM pg_indexes
            WHERE schemaname = 'training' AND tablename NOT IN ('foods', 'meal_entries')
            ORDER BY 1
            """, connection);
        await using var reader = await command.ExecuteReaderAsync(Ct);
        var objects = new List<string>();
        while (await reader.ReadAsync(Ct)) objects.Add(reader.GetString(0));
        return objects.ToArray();
    }

    private sealed class FakeOff : IOffClient
    {
        private readonly ConcurrentQueue<string> _calls = new();
        public int SearchCalls => _calls.Count(x => x == "search");
        public int LookupCalls => _calls.Count(x => x == "lookup");
        public Func<string, CancellationToken, Task<OffSearchPage>> Search { get; set; } = (_, _) => Task.FromResult(new OffSearchPage(
            [new OffFoodData("12345678", "Arroz sintético", null, 130m, 2m, 28m, .3m)]));
        public Func<string, CancellationToken, Task<OffFoodData?>> Lookup { get; set; } = (_, _) => Task.FromResult<OffFoodData?>(null);
        public Task<OffSearchPage> SearchAsync(string query, CancellationToken cancellationToken) { _calls.Enqueue("search"); return Search(query, cancellationToken); }
        public Task<OffFoodData?> LookupAsync(string barcode, CancellationToken cancellationToken) { _calls.Enqueue("lookup"); return Lookup(barcode, cancellationToken); }
    }
}
