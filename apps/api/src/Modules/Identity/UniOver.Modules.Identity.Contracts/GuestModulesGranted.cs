using UniOver.SharedKernel;

namespace UniOver.Modules.Identity.Contracts;

/// <summary>
/// Uma conta de convidado passou a ter módulos que não tinha: ao aceitar o convite (todos os módulos dele) ou quando o
/// administrador acrescenta um módulo às permissões. Sai pela outbox do Identity na MESMA transação da concessão, e cada
/// módulo decide o que isso significa para ele (a TV, por exemplo, liga a conta à TV padrão). Imutável depois de publicado.
/// </summary>
/// <param name="UserId">A conta que ganhou os módulos.</param>
/// <param name="Modules">Só os módulos que entraram agora, no formato do catálogo (<c>module:tv</c>).</param>
public sealed record GuestModulesGranted(Guid Id, DateTimeOffset OccurredAt, Guid UserId, IReadOnlyList<string> Modules) : IIntegrationEvent
{
    public const string EventType = "identity.guest-modules-granted.v1";

    public string Type => EventType;
}
