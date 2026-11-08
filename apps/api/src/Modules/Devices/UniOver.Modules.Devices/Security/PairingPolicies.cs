using Microsoft.AspNetCore.Authorization;
using UniOver.BuildingBlocks.Web;

namespace UniOver.Modules.Devices.Security;

/// <summary>Políticas de autorização do Devices que não são de um papel só.</summary>
internal static class PairingPolicies
{
    /// <summary>
    /// A aprovação do convidado para o próprio computador: conta ativa com a permissão de ver a TV (<c>module:tv</c>) ou a
    /// de controlar o PC (<c>module:pc</c>) e a confirmação recente da senha (<see cref="GuestStepUpActions.PairSelf"/>),
    /// presa à sessão e curta como a da passkey. A confirmação é lida pelo Identity (que guarda as confirmações); aqui só
    /// se declara o requisito.
    /// </summary>
    public const string ApproveOwn = "devices:approve-own";

    /// <summary>A mesma permissão, sem a confirmação da senha: só em Development com a confirmação dispensada.</summary>
    public const string ApproveOwnPermissionOnly = "devices:approve-own-permission";

    public static void Configure(AuthorizationPolicyBuilder policy)
    {
        ArgumentNullException.ThrowIfNull(policy);
        ConfigurePermissionOnly(policy);
        policy.AddRequirements(new StepUpRequirement(GuestStepUpActions.PairSelf));
    }

    public static void ConfigurePermissionOnly(AuthorizationPolicyBuilder policy)
    {
        ArgumentNullException.ThrowIfNull(policy);
        policy.RequireAnyPermission(AccessPermissions.TvModule, AccessPermissions.PcModule);
    }
}
