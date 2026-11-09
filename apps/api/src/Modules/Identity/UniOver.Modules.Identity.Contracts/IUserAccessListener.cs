namespace UniOver.Modules.Identity.Contracts;

/// <summary>O que mudou no acesso de uma pessoa.</summary>
public enum UserAccessChangeKind
{
    /// <summary>Uma sessão (a família do refresh em <c>SessionId</c>) acabou: sair, revogar o aparelho, reutilização do token.</summary>
    SessionEnded = 0,

    /// <summary>
    /// Todas as sessões da pessoa acabaram ("sair de todos", senha trocada ou recuperada), menos a de <c>SessionId</c> quando
    /// informada (a que fez a troca segue).
    /// </summary>
    SessionsEnded = 1,

    /// <summary>A conta foi pausada ou revogada: nada dela vale mais.</summary>
    AccountDisabled = 2,

    /// <summary>Uma permissão de módulo foi retirada (<c>Module</c>, ex.: <c>module:pc</c>).</summary>
    ModuleRemoved = 3,
}

/// <summary>Uma mudança de acesso, já confirmada no banco. Só ids e nomes de módulo: nunca credencial.</summary>
public sealed record UserAccessChange(Guid UserId, UserAccessChangeKind Kind, Guid? SessionId = null, string? Module = null);

/// <summary>
/// Quem precisa reagir na hora a uma mudança de acesso (o canal direto do controle do PC, que não passa pela API a cada
/// comando e por isso não perceberia a sessão acabar). Em processo, como os caches de permissão do Identity: a falha de um
/// ouvinte nunca desfaz a mudança nem derruba quem a fez.
/// </summary>
public interface IUserAccessListener
{
    Task ChangedAsync(UserAccessChange change, CancellationToken cancellationToken = default);
}
