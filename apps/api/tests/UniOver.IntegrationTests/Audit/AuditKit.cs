using System.Diagnostics.CodeAnalysis;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Npgsql;
using UniOver.BuildingBlocks.Persistence;
using UniOver.IntegrationTests.Devices.Pairing;
using UniOver.IntegrationTests.Guards;
using UniOver.IntegrationTests.Identity;
using UniOver.IntegrationTests.Infrastructure;
using UniOver.IntegrationTests.Tv;
using UniOver.Modules.Devices.Domain;
using UniOver.Modules.Identity.Domain;
using UniOver.Modules.Tv.Domain;

namespace UniOver.IntegrationTests.Audit;

/// <summary>Atalhos dos testes de auditoria: banco com os três módulos migrados, linhas semeadas e leitura da rota do administrador.</summary>
internal static class AuditKit
{
    public const string Route = "/api/v1/identity/audit";

    public static CancellationToken Ct => TestContext.Current.CancellationToken;

    /// <summary>Um banco novo com Identity, Devices e Tv migrados pelo papel dono (o que a esteira faz em produção).</summary>
    public static async Task<TestDatabase> MigratedDatabaseAsync(PostgresFixture postgres)
    {
        ArgumentNullException.ThrowIfNull(postgres);

        var database = await postgres.CreateDatabaseAsync();
        await using (var identity = IdentityApp.CreateContext(database.OwnerConnection))
        {
            await identity.Database.MigrateAsync(Ct);
        }

        await using (var devices = DevicesApp.CreateContext(database.OwnerConnection))
        {
            await devices.Database.MigrateAsync(Ct);
        }

        await using (var tv = TvApp.CreateContext(database.OwnerConnection))
        {
            await tv.Database.MigrateAsync(Ct);
        }

        NpgsqlConnection.ClearAllPools();
        return database;
    }

    /// <summary>Todas as migrations de todos os módulos registrados no Host, num banco novo (mesmo caminho da guarda de schemas).</summary>
    public static async Task<(TestDatabase Database, IReadOnlyList<ModuleDbContextRegistration> Modules)> MigrateEverythingAsync(
        PostgresFixture postgres)
    {
        ArgumentNullException.ThrowIfNull(postgres);

        var database = await postgres.CreateDatabaseAsync();
        IReadOnlyList<ModuleDbContextRegistration> modules;
        await using (var factory = await GuardHost.StartAsync(postgres, "Production"))
        {
            modules = factory.Services.GetRequiredService<ModuleDbContextRegistry>().Registrations;
        }

        foreach (var module in modules)
        {
            var optionsType = typeof(DbContextOptionsBuilder<>).MakeGenericType(module.ContextType);
            var builder = (DbContextOptionsBuilder)Activator.CreateInstance(optionsType)!;
            ModuleDatabase.Configure(builder, database.OwnerConnection, module.Schema, module.ContextType.Assembly);

            await using var context = (DbContext)Activator.CreateInstance(module.ContextType, builder.Options)!;
            await context.Database.MigrateAsync(Ct);
        }

        NpgsqlConnection.ClearAllPools();
        return (database, modules);
    }

    /// <summary>O Host real contra um banco já migrado com os três módulos, com o dono semeado.</summary>
    public static Task<IdentityApp> StartAppAsync(PostgresFixture postgres, TestDatabase database, bool forwardedHeaders = false) =>
        IdentityApp.StartAsync(postgres, new IdentityAppOptions { Database = database, ForwardedHeaders = forwardedHeaders });

    public static async Task<Guid> OwnerIdAsync(IdentityApp app)
    {
        await using var db = app.Db();
        return await db.Users.Where(u => u.Role == UniOver.BuildingBlocks.Web.AccountRoles.Owner).Select(u => u.Id).SingleAsync(Ct);
    }

    public static async Task AddAsync(TestDatabase database, params LoginAuditEntry[] entries)
    {
        await using var db = IdentityApp.CreateContext(database.OwnerConnection);
        db.LoginAudit.AddRange(entries);
        await db.SaveChangesAsync(Ct);
    }

    public static async Task AddAsync(TestDatabase database, params PairingAuditEntry[] entries)
    {
        await using var db = DevicesApp.CreateContext(database.OwnerConnection);
        db.PairingAudit.AddRange(entries);
        await db.SaveChangesAsync(Ct);
    }

    public static async Task AddAsync(TestDatabase database, params CommandAuditEntry[] entries)
    {
        await using var db = TvApp.CreateContext(database.OwnerConnection);
        db.CommandAudit.AddRange(entries);
        await db.SaveChangesAsync(Ct);
    }

    public static async Task AddAgentAsync(TestDatabase database, Agent agent)
    {
        await using var db = DevicesApp.CreateContext(database.OwnerConnection);
        db.Agents.Add(agent);
        await db.SaveChangesAsync(Ct);
    }

    public static CommandAuditEntry Command(
        Guid user, string command, string? detail, bool ok, DateTimeOffset at, string? error = null, string ip = "203.0.113.5", string agent = "UA-tv") =>
        CommandAuditEntry.Create(user, "pc-casa", command, detail, ok, error, ok ? 100 : null, new UniOver.Modules.Tv.Domain.ClientInfo(ip, agent), at);

    public static async Task<HttpResponseMessage> GetAsync(IdentityApp app, string bearer, string query = "", string path = "") =>
        await app.GetAsync(Route + path + query, bearer);

    public static async Task<JsonElement> GetJsonAsync(IdentityApp app, string bearer, string query = "")
    {
        using var response = await GetAsync(app, bearer, query);
        response.EnsureSuccessStatusCode();
        return await response.Content.ReadFromJsonAsync<JsonElement>(Ct);
    }

    [SuppressMessage("Security", "CA2100:Review SQL queries for security vulnerabilities",
        Justification = "SQL de teste montado só com nomes e números gerados aqui, sem texto de usuário.")]
    public static async Task<long> ScalarAsync(string connection, string sql, params (string Name, object Value)[] parameters)
    {
        await using var conn = new NpgsqlConnection(connection);
        await conn.OpenAsync(Ct);
        await using var command = new NpgsqlCommand(sql, conn);
        foreach (var (name, value) in parameters)
        {
            command.Parameters.AddWithValue(name, value);
        }

        return Convert.ToInt64(await command.ExecuteScalarAsync(Ct), System.Globalization.CultureInfo.InvariantCulture);
    }

    [SuppressMessage("Security", "CA2100:Review SQL queries for security vulnerabilities",
        Justification = "SQL de teste montado só com nomes e números gerados aqui, sem texto de usuário.")]
    public static async Task ExecuteAsync(string connection, string sql)
    {
        await using var conn = new NpgsqlConnection(connection);
        await conn.OpenAsync(Ct);
        await using var command = new NpgsqlCommand(sql, conn);
        await command.ExecuteNonQueryAsync(Ct);
    }
}
