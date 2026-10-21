using UniOver.SharedKernel;

namespace UniOver.Modules.Tv.Domain;

/// <summary>
/// Uma TV configurada pelo administrador no app (tabela <c>tvs</c>). Por enquanto existe uma só e ela é a padrão: é o
/// computador (agente) dela que recebe os comandos. A tabela já nasce no formato que várias TVs vão precisar; hoje a
/// regra "exatamente uma padrão" vale por um índice único parcial no banco.
/// </summary>
public sealed class ConfiguredTv
{
    public const int NameMax = 60;
    public const int AgentSlugMax = 40;

    /// <summary>Nome da TV quando quem salvou não escolheu um.</summary>
    public const string DefaultName = "TV";

    // Para o EF Core materializar a linha.
    private ConfiguredTv()
    {
    }

    public Guid Id { get; private set; }

    public string Name { get; private set; } = string.Empty;

    /// <summary>
    /// O <c>agentId</c> do computador que controla esta TV. Sem chave estrangeira: o agente é do Devices e a validação
    /// contra os pareados (e não revogados) acontece ao salvar, pela porta de contrato.
    /// </summary>
    public string AgentSlug { get; private set; } = string.Empty;

    public bool IsDefault { get; private set; }

    public DateTimeOffset CreatedAt { get; private set; }

    public DateTimeOffset UpdatedAt { get; private set; }

    /// <summary>A conta que salvou por último (só o id: a conta é do Identity).</summary>
    public Guid UpdatedBy { get; private set; }

    public static ConfiguredTv CreateDefault(string? name, string agentSlug, Guid updatedBy, DateTimeOffset now)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(agentSlug);

        return new ConfiguredTv
        {
            Id = IdGenerator.NewId(),
            Name = string.IsNullOrWhiteSpace(name) ? DefaultName : name.Trim(),
            AgentSlug = agentSlug,
            IsDefault = true,
            CreatedAt = now,
            UpdatedAt = now,
            UpdatedBy = updatedBy,
        };
    }

    /// <summary>
    /// Passa o controle desta TV para outro computador. Devolve <c>false</c> (e não muda nada, nem a data) quando o
    /// computador e o nome já eram esses. Nome nulo mantém o atual.
    /// </summary>
    public bool Rebind(string agentSlug, string? name, Guid updatedBy, DateTimeOffset now)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(agentSlug);

        var newName = string.IsNullOrWhiteSpace(name) ? Name : name.Trim();
        if (string.Equals(AgentSlug, agentSlug, StringComparison.Ordinal) && string.Equals(Name, newName, StringComparison.Ordinal))
        {
            return false;
        }

        AgentSlug = agentSlug;
        Name = newName;
        UpdatedAt = now;
        UpdatedBy = updatedBy;
        return true;
    }
}
