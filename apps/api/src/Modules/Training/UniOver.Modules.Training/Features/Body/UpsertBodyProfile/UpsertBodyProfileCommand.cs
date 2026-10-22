namespace UniOver.Modules.Training.Features.Body.UpsertBodyProfile;

/// <summary>
/// Corpo do <c>PUT /body/profile</c>: o perfil inteiro. A chave natural é o usuário da sessão (não há id na rota), e não
/// existe lápide: o perfil só troca de valor. O fator de atividade vazio assume o padrão.
/// </summary>
internal sealed record UpsertBodyProfileRequest(
    decimal? HeightCm,
    DateOnly? BirthDate,
    string? Sex,
    decimal? ActivityFactor,
    DateTimeOffset? ClientUpdatedAt);

/// <summary>O pedido já validado e normalizado (instantes no relógio de armazenamento).</summary>
internal sealed record UpsertBodyProfileCommand(
    Guid UserId,
    decimal HeightCm,
    DateOnly BirthDate,
    string Sex,
    decimal ActivityFactor,
    DateTimeOffset ClientUpdatedAt);

internal enum UpsertBodyProfileOutcome
{
    Ok,
    ClockAhead,
}

internal sealed record UpsertBodyProfileResult(UpsertBodyProfileOutcome Outcome, BodyProfileResponse? Profile = null);
