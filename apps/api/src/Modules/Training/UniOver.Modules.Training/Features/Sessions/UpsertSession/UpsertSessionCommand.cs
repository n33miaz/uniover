namespace UniOver.Modules.Training.Features.Sessions.UpsertSession;

/// <summary>Corpo do <c>PUT /sessions/{id}</c>: a sessão inteira, escrita no aparelho (o id é do aparelho).</summary>
internal sealed record UpsertSessionRequest(
    Guid? RoutineId,
    DateTimeOffset? StartedAt,
    DateTimeOffset? FinishedAt,
    string? Note,
    int? Feeling,
    string? DeviceId,
    DateTimeOffset? ClientUpdatedAt,
    bool Deleted);

/// <summary>O pedido já validado e normalizado (texto aparado, instantes no relógio de armazenamento).</summary>
internal sealed record UpsertSessionCommand(
    Guid UserId,
    Guid Id,
    Guid? RoutineId,
    DateTimeOffset StartedAt,
    DateTimeOffset? FinishedAt,
    string? Note,
    int? Feeling,
    string DeviceId,
    DateTimeOffset ClientUpdatedAt,
    bool Deleted);

internal enum UpsertSessionOutcome
{
    Ok,
    NotFound,
    RoutineNotFound,
    FinishBeforeStart,
    ClockAhead,
    AlreadyOpen,
}

/// <summary>Quando recusada por já haver um treino aberto, diz qual (para o aparelho dono encerrá-lo).</summary>
internal sealed record OpenSessionInfo(Guid SessionId, string DeviceId, DateTimeOffset StartedAt);

internal sealed record UpsertSessionResult(
    UpsertSessionOutcome Outcome, SessionResponse? Session = null, OpenSessionInfo? Open = null);
