using UniOver.SharedKernel;

namespace UniOver.Modules.Devices.Domain;

/// <summary>O que a consulta do agente deve receber, decidido por regra pura (sem banco nem relógio global).</summary>
public enum PollOutcome
{
    /// <summary>Ainda esperando o dono aprovar.</summary>
    Pending,

    /// <summary>Consultou antes do intervalo mínimo: a resposta manda esperar mais.</summary>
    SlowDown,

    /// <summary>Aprovado e ainda sem token entregue: é a hora de emitir o token (uma vez).</summary>
    Approved,

    /// <summary>O prazo do código passou sem aprovação.</summary>
    Expired,

    /// <summary>O dono recusou.</summary>
    Denied,

    /// <summary>O token já foi entregue: o segredo não sai de novo.</summary>
    Consumed,
}

/// <summary>Limites de texto do que vem do agente (anônimo): nada disso pode inflar a tabela.</summary>
public static class PairingText
{
    public const int NameMax = 60;
    public const int PlatformMax = 30;
    public const int VersionMax = 30;
}

/// <summary>
/// Um pedido de pareamento (estilo "device authorization"): o agente pede, o dono aprova com o código curto e o
/// agente recolhe o token. Guarda só o hash do <c>deviceCode</c>.
/// </summary>
public sealed class PairingRequest
{
    // Para o EF Core materializar a linha.
    private PairingRequest()
    {
    }

    public Guid Id { get; private set; }

    public byte[] DeviceCodeHash { get; private set; } = [];

    /// <summary>Forma guardada, sem hífen (<see cref="UserCode.Normalize"/>).</summary>
    public string UserCode { get; private set; } = string.Empty;

    public string RequestedName { get; private set; } = string.Empty;

    public string RequestedSlug { get; private set; } = string.Empty;

    public string Platform { get; private set; } = string.Empty;

    public string AgentVersion { get; private set; } = string.Empty;

    public DateTimeOffset CreatedAt { get; private set; }

    public DateTimeOffset ExpiresAt { get; private set; }

    public DateTimeOffset? LastPolledAt { get; private set; }

    public DateTimeOffset? ApprovedAt { get; private set; }

    /// <summary>Id do usuário que aprovou; sem chave estrangeira (usuário é outro módulo).</summary>
    public Guid? ApprovedBy { get; private set; }

    public string? ApprovedName { get; private set; }

    public DateTimeOffset? ConsumedAt { get; private set; }

    public DateTimeOffset? DeniedAt { get; private set; }

    /// <summary>O agente criado na aprovação.</summary>
    public Guid? AgentId { get; private set; }

    public static PairingRequest Create(
        byte[] deviceCodeHash,
        string userCode,
        string requestedName,
        string requestedSlug,
        string platform,
        string agentVersion,
        DateTimeOffset now,
        TimeSpan validFor)
    {
        ArgumentNullException.ThrowIfNull(deviceCodeHash);
        ArgumentException.ThrowIfNullOrWhiteSpace(userCode);
        if (validFor <= TimeSpan.Zero)
        {
            throw new ArgumentOutOfRangeException(nameof(validFor), "O código precisa valer um tempo positivo.");
        }

        return new PairingRequest
        {
            Id = IdGenerator.NewId(),
            DeviceCodeHash = deviceCodeHash,
            UserCode = userCode,
            RequestedName = requestedName,
            RequestedSlug = requestedSlug,
            Platform = platform,
            AgentVersion = agentVersion,
            CreatedAt = now,
            ExpiresAt = now + validFor,
        };
    }

    /// <summary>Ainda dentro do prazo (no instante do vencimento já não vale, como nas confirmações do Identity).</summary>
    public bool IsExpiredAt(DateTimeOffset now) => now >= ExpiresAt;

    /// <summary>O dono ainda pode aprovar ou recusar: no prazo e sem decisão nem token entregue.</summary>
    public bool IsOpenAt(DateTimeOffset now) =>
        !IsExpiredAt(now) && ApprovedAt is null && DeniedAt is null && ConsumedAt is null;

    /// <summary>
    /// Decide a resposta da consulta. A ordem importa: o que é definitivo (token entregue, recusa, prazo) vem antes
    /// do ritmo, e a aprovação nunca é atrasada por <c>slow_down</c> (o agente já esperou o suficiente).
    /// </summary>
    public PollOutcome Evaluate(DateTimeOffset now, TimeSpan minimumInterval)
    {
        if (ConsumedAt is not null)
        {
            return PollOutcome.Consumed;
        }

        if (DeniedAt is not null)
        {
            return PollOutcome.Denied;
        }

        if (ApprovedAt is not null)
        {
            return PollOutcome.Approved;
        }

        if (IsExpiredAt(now))
        {
            return PollOutcome.Expired;
        }

        return LastPolledAt is { } last && now - last < minimumInterval ? PollOutcome.SlowDown : PollOutcome.Pending;
    }

    public void RegisterPoll(DateTimeOffset now) => LastPolledAt = now;

    public void Approve(DateTimeOffset now, Guid approvedBy, string approvedName, Guid agentId)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(approvedName);
        if (!IsOpenAt(now))
        {
            throw new InvalidOperationException("O pareamento não está aberto para aprovação.");
        }

        ApprovedAt = now;
        ApprovedBy = approvedBy;
        ApprovedName = approvedName;
        AgentId = agentId;
    }

    public void Deny(DateTimeOffset now)
    {
        if (!IsOpenAt(now))
        {
            throw new InvalidOperationException("O pareamento não está aberto para recusa.");
        }

        DeniedAt = now;
    }

    /// <summary>Marca o token como entregue; só vale para um pareamento aprovado e ainda não consumido.</summary>
    public void Consume(DateTimeOffset now)
    {
        if (ApprovedAt is null || ConsumedAt is not null)
        {
            throw new InvalidOperationException("O pareamento não tem token a entregar.");
        }

        ConsumedAt = now;
    }
}
