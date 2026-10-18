using Fido2NetLib;
using Fido2NetLib.Objects;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using UniOver.Modules.Identity.Domain;

namespace UniOver.Modules.Identity.Security;

/// <summary>
/// Porta única para a biblioteca de WebAuthn. Escolhida a <c>Fido2</c> (e não o tratador de passkeys do Identity
/// do ASP.NET) porque a conta é a nossa tabela, sem <c>UserManager</c>, e porque a biblioteca valida a atestação e
/// a asserção sem estado de cookie. Nenhum serviço de metadados é ligado: o app não consulta a rede para
/// validar autenticador, e a atestação pedida é <c>none</c>.
/// </summary>
internal sealed partial class WebAuthn
{
    private readonly Lazy<Fido2> _fido2;

    public WebAuthn(IOptions<PasskeyOptions> options, IHostEnvironment environment, ILogger<WebAuthn> logger)
    {
        ArgumentNullException.ThrowIfNull(options);
        ArgumentNullException.ThrowIfNull(environment);
        ArgumentNullException.ThrowIfNull(logger);

        // PublicationOnly: uma configuração ausente não fica gravada como falha para sempre; basta corrigir a variável.
        _fido2 = new Lazy<Fido2>(() => Build(options.Value, environment, logger), LazyThreadSafetyMode.PublicationOnly);
    }

    [LoggerMessage(Level = LogLevel.Error, Message = "Modules:Identity:Passkeys:RpId e Origins ausentes: as passkeys não funcionam sem o host e a origem do app.")]
    private static partial void LogMissingConfiguration(ILogger logger);

    private static Fido2 Build(PasskeyOptions options, IHostEnvironment environment, ILogger logger)
    {
        var rpId = options.RpId?.Trim();
        var origins = options.Origins.Where(o => !string.IsNullOrWhiteSpace(o)).Select(o => o.Trim()).ToList();

        // Em desenvolvimento e teste, localhost serve; em qualquer outro ambiente a falta é erro claro (e vai para o log).
        if (environment.IsDevelopment() || environment.IsEnvironment("Testing"))
        {
            rpId = string.IsNullOrEmpty(rpId) ? "localhost" : rpId;
            if (origins.Count == 0)
            {
                origins.Add("https://localhost");
            }
        }

        if (string.IsNullOrEmpty(rpId) || origins.Count == 0)
        {
            LogMissingConfiguration(logger);
            throw new InvalidOperationException("Modules:Identity:Passkeys:RpId e Origins ausentes.");
        }

        return new Fido2(
            new Fido2Configuration
            {
                RPID = rpId,
                RPName = options.ServerName,
                Origins = new HashSet<string>(origins, StringComparer.Ordinal),
                ChallengeSize = 32,
            },
            metadataService: null!);
    }

    public CredentialCreateOptions CreateRegistrationOptions(User user, IReadOnlyList<Passkey> existing)
    {
        ArgumentNullException.ThrowIfNull(user);
        ArgumentNullException.ThrowIfNull(existing);

        return _fido2.Value.RequestNewCredential(new RequestNewCredentialParams
        {
            User = new Fido2User { Id = UserHandle(user.Id), Name = user.Email, DisplayName = user.DisplayName },

            // Sem repetir uma passkey que o dono já tem neste aparelho.
            ExcludeCredentials = [.. existing.Select(Describe)],
            AuthenticatorSelection = new AuthenticatorSelection
            {
                ResidentKey = ResidentKeyRequirement.Preferred,
                UserVerification = UserVerificationRequirement.Required,
            },
            AttestationPreference = AttestationConveyancePreference.None,
            PubKeyCredParams = [PubKeyCredParam.ES256, PubKeyCredParam.RS256],
        });
    }

    public AssertionOptions CreateAssertionOptions(IReadOnlyList<Passkey> passkeys)
    {
        ArgumentNullException.ThrowIfNull(passkeys);

        return _fido2.Value.GetAssertionOptions(new GetAssertionOptionsParams
        {
            AllowedCredentials = [.. passkeys.Select(Describe)],
            UserVerification = UserVerificationRequirement.Required,
        });
    }

    public Task<RegisteredPublicKeyCredential> VerifyRegistrationAsync(
        AuthenticatorAttestationRawResponse response,
        CredentialCreateOptions options,
        Func<byte[], CancellationToken, Task<bool>> isCredentialIdFree,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(isCredentialIdFree);

        return _fido2.Value.MakeNewCredentialAsync(
            new MakeNewCredentialParams
            {
                AttestationResponse = response,
                OriginalOptions = options,
                IsCredentialIdUniqueToUserCallback = (p, ct) => isCredentialIdFree(p.CredentialId, ct),
            },
            cancellationToken);
    }

    public Task<VerifyAssertionResult> VerifyAssertionAsync(
        AuthenticatorAssertionRawResponse response,
        AssertionOptions options,
        Passkey passkey,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(passkey);

        var handle = UserHandle(passkey.UserId);
        return _fido2.Value.MakeAssertionAsync(
            new MakeAssertionParams
            {
                AssertionResponse = response,
                OriginalOptions = options,
                StoredPublicKey = passkey.PublicKey,
                StoredSignatureCounter = (uint)Math.Clamp(passkey.SignCount, 0, uint.MaxValue),

                // A passkey já foi achada entre as do usuário logado; aqui só se confere o identificador gravado nela.
                IsUserHandleOwnerOfCredentialIdCallback = (p, ct) =>
                    Task.FromResult(p.UserHandle is not { Length: > 0 } || handle.AsSpan().SequenceEqual(p.UserHandle)),
            },
            cancellationToken);
    }

    public static byte[] UserHandle(Guid userId) => userId.ToByteArray();

    private static PublicKeyCredentialDescriptor Describe(Passkey passkey)
    {
        var transports = (passkey.Transports ?? string.Empty)
            .Split(',', StringSplitOptions.RemoveEmptyEntries)
            .Select(t => Enum.TryParse<AuthenticatorTransport>(t, ignoreCase: true, out var parsed) ? (AuthenticatorTransport?)parsed : null)
            .OfType<AuthenticatorTransport>()
            .ToArray();
        return new PublicKeyCredentialDescriptor(PublicKeyCredentialType.PublicKey, passkey.CredentialId, transports);
    }
}
