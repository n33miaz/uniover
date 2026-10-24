namespace UniOver.Modules.Tv.Domain;

/// <summary>
/// Liga uma conta à TV que ela pode usar. Não há chave estrangeira para a conta: ela pertence ao módulo Identity e esta
/// tabela guarda somente o identificador necessário para decidir a visibilidade.
/// </summary>
public sealed class TvMember
{
    private TvMember()
    {
    }

    public Guid TvId { get; private set; }

    public Guid UserId { get; private set; }

    public DateTimeOffset AddedAt { get; private set; }

    public static TvMember Create(Guid tvId, Guid userId, DateTimeOffset now) => new()
    {
        TvId = tvId,
        UserId = userId,
        AddedAt = now,
    };
}
