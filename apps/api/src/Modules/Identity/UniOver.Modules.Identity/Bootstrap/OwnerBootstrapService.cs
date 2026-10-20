using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using Npgsql;
using UniOver.BuildingBlocks.Web;
using UniOver.Modules.Identity.Domain;
using UniOver.Modules.Identity.Persistence;
using UniOver.Modules.Identity.Security;

namespace UniOver.Modules.Identity.Bootstrap;

/// <summary>
/// Cria a conta do dono na partida, só se <c>identity.users</c> não tem nenhum dono e as duas variáveis de ambiente
/// existem. Não há endpoint de cadastro: este é o único caminho para a conta nascer.
/// <para>
/// Roda em segundo plano e engole qualquer falha: as migrations só entram pela esteira de publicação e o banco
/// pode estar dormindo ou ainda sem as tabelas, e nada disso pode impedir a API de subir (o monitor chama
/// <c>/health/live</c>). A senha nunca vai para log.
/// </para>
/// </summary>
internal sealed partial class OwnerBootstrapService(
    IServiceScopeFactory scopes,
    IConfiguration configuration,
    IOptions<IdentityModuleOptions> options,
    TimeProvider time,
    ILogger<OwnerBootstrapService> logger) : IHostedService, IDisposable
{
    public const string EmailVariable = "UNIOVER_OWNER_EMAIL";
    public const string PasswordVariable = "UNIOVER_OWNER_PASSWORD";

    private CancellationTokenSource? _stopping;
    private Task _run = Task.CompletedTask;

    /// <summary>Termina quando a tentativa de seed acaba (com sucesso, sem trabalho ou com erro registrado).</summary>
    public Task Completion => _run;

    [LoggerMessage(Level = LogLevel.Information, Message = "Conta do dono criada.")]
    private static partial void LogCreated(ILogger logger);

    [LoggerMessage(Level = LogLevel.Warning, Message = "A conta do dono já existe e UNIOVER_OWNER_PASSWORD ainda está no ambiente: remova a variável.")]
    private static partial void LogPasswordStillPresent(ILogger logger);

    [LoggerMessage(Level = LogLevel.Error, Message = "Seed do dono ignorado: defina UNIOVER_OWNER_EMAIL e UNIOVER_OWNER_PASSWORD juntos.")]
    private static partial void LogIncomplete(ILogger logger);

    [LoggerMessage(Level = LogLevel.Error, Message = "Seed do dono ignorado: {Problems}.")]
    private static partial void LogInvalid(ILogger logger, string problems);

    [LoggerMessage(Level = LogLevel.Error, Message = "Seed do dono não executado: as tabelas do módulo ainda não existem. Aplique as migrations pela esteira e reinicie.")]
    private static partial void LogNoTables(ILogger logger);

    [LoggerMessage(Level = LogLevel.Error, Message = "Seed do dono não executado: banco inacessível ou com erro ({ErrorType}). A API segue no ar.")]
    private static partial void LogDatabaseUnavailable(ILogger logger, string errorType);

    [LoggerMessage(Level = LogLevel.Information, Message = "A conta do dono foi criada por outra instância.")]
    private static partial void LogCreatedElsewhere(ILogger logger);

    public Task StartAsync(CancellationToken cancellationToken)
    {
        _stopping = new CancellationTokenSource();
        var token = _stopping.Token;

        // Fora do caminho da partida: StartAsync devolve já, e a conexão (que pode acordar o Neon) acontece depois.
        _run = Task.Run(() => RunSafelyAsync(token), CancellationToken.None);
        return Task.CompletedTask;
    }

    public async Task StopAsync(CancellationToken cancellationToken)
    {
        var stopping = _stopping;
        if (stopping is null)
        {
            return;
        }

        try
        {
            await stopping.CancelAsync();
        }
        catch (ObjectDisposedException)
        {
            // O host já liberou o serviço (encerramento logo depois da partida): a tentativa não está mais rodando.
            return;
        }

        try
        {
            await _run.WaitAsync(cancellationToken);
        }
        catch (OperationCanceledException)
        {
            // O host desistiu de esperar o encerramento: nada a fazer.
        }
    }

    public void Dispose()
    {
        _stopping?.Dispose();
        _stopping = null;
    }

    private async Task RunSafelyAsync(CancellationToken cancellationToken)
    {
        try
        {
            await SeedAsync(cancellationToken);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            // Encerramento do host no meio da tentativa.
        }
        catch (PostgresException ex) when (ex.SqlState == PostgresErrorCodes.UndefinedTable)
        {
            LogNoTables(logger);
        }
        catch (DbUpdateException ex) when (ex.InnerException is PostgresException { SqlState: PostgresErrorCodes.UniqueViolation })
        {
            LogCreatedElsewhere(logger);
        }
#pragma warning disable CA1031 // Qualquer falha aqui só pode virar log: o seed nunca pode derrubar a partida.
        catch (Exception ex)
#pragma warning restore CA1031
        {
            // Só o tipo da exceção: a mensagem de driver pode trazer detalhes de conexão.
            LogDatabaseUnavailable(logger, ex.GetType().Name);
        }
    }

    private async Task SeedAsync(CancellationToken cancellationToken)
    {
        var email = configuration[EmailVariable];
        var password = configuration[PasswordVariable];
        var hasEmail = !string.IsNullOrWhiteSpace(email);
        var hasPassword = !string.IsNullOrEmpty(password);

        // Sem as variáveis não há o que semear nem o que avisar: nem se abre conexão com o banco.
        if (!hasEmail && !hasPassword)
        {
            return;
        }

        await using var scope = scopes.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<IdentityDbContext>();

        // Só a conta do dono conta: convidados não impedem o seed de recriar o dono se a linha dele for apagada à mão.
        if (await db.Users.AnyAsync(u => u.Role == AccountRoles.Owner, cancellationToken))
        {
            if (hasPassword)
            {
                LogPasswordStillPresent(logger);
            }

            return;
        }

        if (!hasEmail || !hasPassword)
        {
            LogIncomplete(logger);
            return;
        }

        var problems = new List<string>();
        if (!EmailRules.IsValid(email))
        {
            problems.Add("e-mail inválido");
        }

        problems.AddRange(PasswordPolicy.Validate(password, options.Value.MinPasswordLength));
        if (problems.Count > 0)
        {
            LogInvalid(logger, string.Join(", ", problems));
            return;
        }

        var passwords = scope.ServiceProvider.GetRequiredService<PasswordService>();
        var now = time.GetUtcNow();
        var normalized = EmailRules.Normalize(email!);
        var displayName = normalized[..normalized.IndexOf('@', StringComparison.Ordinal)];

        var user = User.Create(normalized, displayName, passwords.Hash(password!), now);

        db.Users.Add(user);
        db.LoginAudit.Add(LoginAuditEntry.Create(user.Id, AuditEvents.OwnerCreated, now, null, null));
        await db.SaveChangesAsync(cancellationToken);
        LogCreated(logger);
    }
}
