using System.Collections.Frozen;
using Microsoft.AspNetCore.Authorization;
using Microsoft.Extensions.DependencyInjection;

namespace UniOver.BuildingBlocks.Web;

/// <summary>
/// Catálogo FECHADO das permissões que uma conta de convidado pode receber. O texto de cada uma em português vive só
/// na tela; aqui ficam os identificadores estáveis (gravados no banco, no convite e na auditoria). Permissão nova só
/// entra aqui junto com uma migration (o banco confere a lista) e com o texto na tela. O dono (<c>owner</c>) tem todas,
/// de forma implícita: não há linha de concessão para ele.
/// </summary>
public static class AccessPermissions
{
    /// <summary>Ver o módulo da TV (sem isto, nenhuma permissão <c>tv:*</c> vale).</summary>
    public const string TvModule = "module:tv";

    /// <summary>Teclas, texto, acordar e limpar a TV (a limpeza fecha apps e libera memória).</summary>
    public const string TvControl = "tv:control";

    /// <summary>Desligar a TV.</summary>
    public const string TvPower = "tv:power";

    /// <summary>Abrir aplicativos pelos atalhos.</summary>
    public const string TvLaunch = "tv:launch";

    /// <summary>Renomear, ocultar e reordenar os atalhos.</summary>
    public const string TvEditShortcuts = "tv:edit-shortcuts";

    /// <summary>
    /// Legada: não dá acesso a nada. O histórico das TVs é só do administrador (nenhuma rota usa esta permissão). Continua no
    /// catálogo porque convites e concessões já gravados a carregam, e tirá-la de lá recusaria listas que hoje são válidas.
    /// </summary>
    public const string TvHistory = "tv:history";

    /// <summary>Usar o módulo de Treino (só os dados da própria conta).</summary>
    public const string TrainingModule = "module:training";

    /// <summary>Prefixo do nome das políticas por permissão (uma por item do catálogo).</summary>
    public const string PolicyPrefix = "permission:";

    /// <summary>Todas as permissões, na ordem em que a API as devolve.</summary>
    public static IReadOnlyList<string> All { get; } =
    [
        TvModule,
        TvControl,
        TvPower,
        TvLaunch,
        TvEditShortcuts,
        TvHistory,
        TrainingModule,
    ];

    /// <summary>As permissões de módulo: dar acesso a uma área inteira. Toda concessão precisa de ao menos uma.</summary>
    public static IReadOnlyList<string> Modules { get; } = [TvModule, TrainingModule];

    private static readonly FrozenSet<string> KnownSet = All.ToFrozenSet(StringComparer.Ordinal);

    private static readonly FrozenSet<string> ModuleSet = Modules.ToFrozenSet(StringComparer.Ordinal);

    /// <summary>O catálogo inteiro como conjunto: o que o dono tem.</summary>
    public static IReadOnlySet<string> AllSet => KnownSet;

    /// <summary>Comparação exata (caixa e espaços contam): "TV:Control" não é permissão.</summary>
    public static bool IsKnown(string? permission) => permission is not null && KnownSet.Contains(permission);

    public static bool IsModule(string? permission) => permission is not null && ModuleSet.Contains(permission);

    /// <summary>
    /// A permissão de módulo sem a qual <paramref name="permission"/> não vale (qualquer <c>tv:*</c> exige
    /// <c>module:tv</c>); nulo para as próprias permissões de módulo.
    /// </summary>
    public static string? RequiredModule(string permission) => permission switch
    {
        TvControl or TvPower or TvLaunch or TvEditShortcuts or TvHistory => TvModule,
        _ => null,
    };

    /// <summary>Nome da política que exige <paramref name="permission"/>.</summary>
    /// <exception cref="ArgumentException">Permissão fora do catálogo: falhar ao mapear a rota é melhor que gerar uma rota que ninguém alcança.</exception>
    public static string Policy(string permission)
    {
        if (!IsKnown(permission))
        {
            throw new ArgumentException("Permissão fora do catálogo.", nameof(permission));
        }

        return PolicyPrefix + permission;
    }
}

/// <summary>
/// Porta: a conta tem a permissão agora? Quem guarda as concessões (o módulo de identidade) a implementa, lendo do
/// BANCO, com cache curto (padrão 30 s: o mesmo teto da revogação do convidado), nunca de uma claim do JWT, para uma
/// mudança de permissão valer logo. Fica aqui para os módulos decidirem o acesso sem referenciar o interior do Identity
/// (um módulo extraído troca por um cliente HTTP). Falha fechada: sem conseguir consultar, nada é concedido.
/// </summary>
public interface IAccessGrants
{
    /// <summary>Verdadeiro se a conta existe, está ativa e tem <paramref name="permission"/> (o dono tem todas).</summary>
    Task<bool> HasAsync(Guid userId, string permission, CancellationToken cancellationToken = default);

    /// <summary>As permissões em vigor da conta (vazio se ela não existe ou foi revogada), na ordem do catálogo.</summary>
    Task<IReadOnlyList<string>> GetAsync(Guid userId, CancellationToken cancellationToken = default);
}

/// <summary>
/// Exige uma permissão do catálogo. O dono passa sempre (sem consulta); o convidado precisa da concessão no banco;
/// papel ausente ou desconhecido, conta revogada ou porta sem implementação: negado.
/// </summary>
public sealed class PermissionRequirement(string permission) : IAuthorizationRequirement
{
    public string Permission { get; } = permission;
}

internal sealed class PermissionHandler(IServiceProvider services) : AuthorizationHandler<PermissionRequirement>
{
    protected override async Task HandleRequirementAsync(AuthorizationHandlerContext context, PermissionRequirement requirement)
    {
        if (context.User.Identity?.IsAuthenticated != true)
        {
            return;
        }

        var role = AccountRoles.Of(context.User);
        if (string.Equals(role, AccountRoles.Owner, StringComparison.Ordinal))
        {
            // O dono tem todas as permissões, mas só as do catálogo: política de permissão desconhecida nunca vale.
            if (AccessPermissions.IsKnown(requirement.Permission))
            {
                context.Succeed(requirement);
            }

            return;
        }

        if (!string.Equals(role, AccountRoles.Guest, StringComparison.Ordinal))
        {
            return;
        }

        var grants = services.GetService<IAccessGrants>();
        if (grants is null || !Guid.TryParse(context.User.FindFirst(UniOverAuth.SubjectClaim)?.Value, out var userId))
        {
            return;
        }

        if (await grants.HasAsync(userId, requirement.Permission))
        {
            context.Succeed(requirement);
        }
    }
}

public static class PermissionPolicyExtensions
{
    /// <summary>
    /// A política aceita o dono e o convidado ATIVO que tenha a permissão. Já inclui o requisito de papel e o de conta
    /// ativa, para a varredura de rotas reconhecer a política como uma política por papel.
    /// </summary>
    public static AuthorizationPolicyBuilder RequirePermission(this AuthorizationPolicyBuilder builder, string permission)
    {
        ArgumentNullException.ThrowIfNull(builder);
        if (!AccessPermissions.IsKnown(permission))
        {
            throw new ArgumentException("Permissão fora do catálogo.", nameof(permission));
        }

        return builder
            .RequireAccountRole(AccountRoles.Owner, AccountRoles.Guest)
            .RequireActiveAccount()
            .AddRequirements(new PermissionRequirement(permission));
    }
}
