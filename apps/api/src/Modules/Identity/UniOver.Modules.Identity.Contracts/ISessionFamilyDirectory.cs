namespace UniOver.Modules.Identity.Contracts;

/// <summary>
/// Se uma sessão de login (a família do refresh) ainda vale, para quem não conhece a persistência do Identity. O canal direto, que a API
/// reconstrói depois de reiniciar, só volta se a sessão que o abriu continua de pé.
/// </summary>
public interface ISessionFamilyDirectory
{
    /// <summary>
    /// A família existe, é da pessoa, não foi revogada (sair, "sair de todos", senha trocada, reutilização do token) e ainda tem um refresh
    /// dentro da validade. Falha de leitura: a exceção sobe (quem chama fecha por precaução).
    /// </summary>
    Task<bool> IsActiveAsync(Guid userId, Guid familyId, CancellationToken cancellationToken = default);
}
