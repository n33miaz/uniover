using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Authorization.Policy;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using UniOver.Modules.Identity.Features.BeginPasskeyRegistration;
using UniOver.Modules.Identity.Features.CompletePasskeyRegistration;
using UniOver.Modules.Identity.Features.ConfirmStepUp;
using UniOver.Modules.Identity.Features.ConfirmStepUpWithPassword;
using UniOver.Modules.Identity.Features.ListPasskeys;
using UniOver.Modules.Identity.Features.RemovePasskey;
using UniOver.Modules.Identity.Features.RenamePasskey;
using UniOver.Modules.Identity.Features.RequestStepUp;
using UniOver.Modules.Identity.Security;

namespace UniOver.Modules.Identity;

/// <summary>
/// Composição das passkeys de confirmação: opções, serviço de WebAuthn e a política que qualquer módulo usa com
/// <c>StepUp.Policy("acao")</c>. Separada de <c>AddIdentityModule</c> porque o Host a liga numa linha própria.
/// </summary>
public static class IdentityPasskeys
{
    public static IServiceCollection AddIdentityPasskeys(this IServiceCollection services, IConfiguration configuration)
    {
        ArgumentNullException.ThrowIfNull(services);
        ArgumentNullException.ThrowIfNull(configuration);

        // RpId e Origins não são validados na partida: o host sobe sem eles (health, login) e só as passkeys falham,
        // com erro claro no log, no primeiro uso (o mesmo critério da chave do JWT).
        services.AddOptions<PasskeyOptions>().Bind(configuration.GetSection(PasskeyOptions.SectionName));
        services.AddOptions<StepUpOptions>()
            .Bind(configuration.GetSection(StepUpOptions.SectionName))
            .Validate(StepUpOptions.IsValid, "Modules:Identity:StepUp:Minutes deve ficar entre 1 e 60.")
            .ValidateOnStart();

        services.TryAddSingleton(TimeProvider.System);
        services.AddSingleton<WebAuthn>();
        services.AddScoped<ChallengeStore>();

        services.AddScoped<BeginPasskeyRegistrationHandler>();
        services.AddScoped<CompletePasskeyRegistrationHandler>();
        services.AddScoped<ListPasskeysHandler>();
        services.AddScoped<RenamePasskeyHandler>();
        services.AddScoped<RemovePasskeyHandler>();
        services.AddScoped<RequestStepUpHandler>();
        services.AddScoped<ConfirmStepUpHandler>();
        services.AddScoped<ConfirmStepUpWithPasswordHandler>();

        // Replace e não Add: o provedor e o respondedor padrão já existem (ou virão depois, via TryAdd) e só pode haver um.
        services.Replace(ServiceDescriptor.Singleton<IAuthorizationPolicyProvider, StepUpPolicyProvider>());
        services.Replace(ServiceDescriptor.Singleton<IAuthorizationMiddlewareResultHandler, StepUpAuthorizationResponder>());
        services.AddScoped<IAuthorizationHandler, StepUpRequirementHandler>();
        return services;
    }
}
