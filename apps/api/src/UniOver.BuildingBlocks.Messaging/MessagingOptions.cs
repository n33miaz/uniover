using Microsoft.Extensions.Options;

namespace UniOver.BuildingBlocks.Messaging;

/// <summary>Seção <c>Messaging</c>. Os padrões protegem o plano gratuito do Neon (ver o despachante).</summary>
public sealed class MessagingOptions
{
    public const string SectionName = "Messaging";

    /// <summary>
    /// Intervalo da varredura de reserva, em segundos (padrão 6 h). Um único relógio dispara a varredura de todos
    /// os módulos no mesmo instante: dividem um só despertar do banco, que suspende após 5 min parado.
    /// </summary>
    public int IdlePollSeconds { get; set; } = 21600;

    public int BatchSize { get; set; } = 20;

    public int MaxAttempts { get; set; } = 8;
}

internal sealed class MessagingOptionsValidator : IValidateOptions<MessagingOptions>
{
    public ValidateOptionsResult Validate(string? name, MessagingOptions options)
    {
        ArgumentNullException.ThrowIfNull(options);
        var failures = new List<string>();

        // Piso de 60 s: um valor pequeno viraria polling curto e manteria o banco sempre acordado.
        if (options.IdlePollSeconds < 60)
        {
            failures.Add("Messaging:IdlePollSeconds deve ser de pelo menos 60 (varredura de reserva longa, sem polling curto).");
        }

        if (options.BatchSize < 1)
        {
            failures.Add("Messaging:BatchSize deve ser maior que zero.");
        }

        if (options.MaxAttempts < 1)
        {
            failures.Add("Messaging:MaxAttempts deve ser maior que zero.");
        }

        return failures.Count == 0 ? ValidateOptionsResult.Success : ValidateOptionsResult.Fail(failures);
    }
}
