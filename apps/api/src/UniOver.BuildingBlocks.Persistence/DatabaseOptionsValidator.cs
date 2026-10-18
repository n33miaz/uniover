using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Options;

namespace UniOver.BuildingBlocks.Persistence;

/// <summary>Falha rápida no start: melhor o deploy cair do que subir sem banco e só quebrar na primeira requisição.</summary>
internal sealed class DatabaseOptionsValidator(IHostEnvironment environment) : IValidateOptions<DatabaseOptions>
{
    public ValidateOptionsResult Validate(string? name, DatabaseOptions options)
    {
        ArgumentNullException.ThrowIfNull(options);
        var failures = new List<string>();

        var relaxed = environment.IsDevelopment() || environment.IsEnvironment("Testing");
        if (!relaxed && string.IsNullOrWhiteSpace(options.ConnectionString))
        {
            failures.Add("ConnectionStrings:Default é obrigatória fora de Development e Testing.");
        }

        if (options.MaxPoolSize < 1)
        {
            failures.Add("Database:MaxPoolSize deve ser maior que zero.");
        }

        if (options.ConnectionTimeoutSeconds < 1)
        {
            failures.Add("Database:ConnectionTimeoutSeconds deve ser maior que zero.");
        }

        return failures.Count == 0 ? ValidateOptionsResult.Success : ValidateOptionsResult.Fail(failures);
    }
}
