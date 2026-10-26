namespace UniOver.Modules.Tv.Domain;

/// <summary>
/// Marca que a conta já teve filiação a alguma TV e a perdeu. Sem este registro, "nenhuma filiação" não distingue a conta
/// de antes das várias TVs (que continua na TV padrão) de quem foi retirado da sua única TV (que não pode herdar a TV do
/// dono). Sem chave estrangeira: a conta é do Identity e só o identificador interessa aqui.
/// </summary>
public sealed class TvMemberOptOut
{
    private TvMemberOptOut()
    {
    }

    public Guid UserId { get; private set; }

    public DateTimeOffset CreatedAt { get; private set; }

    public static TvMemberOptOut Create(Guid userId, DateTimeOffset now) => new()
    {
        UserId = userId,
        CreatedAt = now,
    };
}
