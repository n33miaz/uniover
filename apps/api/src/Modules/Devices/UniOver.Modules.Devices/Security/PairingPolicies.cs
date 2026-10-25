using Microsoft.AspNetCore.Authorization;
using UniOver.BuildingBlocks.Web;

namespace UniOver.Modules.Devices.Security;

/// <summary>Políticas de autorização do Devices que não são de um papel só.</summary>
internal static class PairingPolicies
{
    /// <summary>
    /// A aprovação do convidado para a própria TV: conta ativa com a permissão de ver a TV (<c>module:tv</c>) e a
    /// confirmação recente da senha (<see cref="GuestStepUpActions.PairSelf"/>), presa à sessão e curta como a da passkey.
    /// A confirmação é lida pelo Identity (que guarda as confirmações); aqui só se declara o requisito.
    /// </summary>
    public const string ApproveOwn = "devices:approve-own";

    public static void Configure(AuthorizationPolicyBuilder policy)
    {
        ArgumentNullException.ThrowIfNull(policy);
        policy
            .RequirePermission(AccessPermissions.TvModule)
            .AddRequirements(new StepUpRequirement(GuestStepUpActions.PairSelf));
    }
}
