namespace UniOver.Modules.Tv.Domain;

/// <summary>
/// Conta que segue a TV padrão enquanto não tem filiação própria: a que ganhou o módulo da TV pelo convite de conta (ou pelo
/// administrador, depois). É o mesmo comportamento que a conta antiga sempre teve, agora só para quem recebeu o módulo de
/// fato: a conta criada sem esta marca (e sem ser antiga) não vê a TV do dono. A filiação e a marca de retirada
/// (<see cref="TvMemberOptOut"/>) continuam valendo antes desta. Sem chave estrangeira: a conta é do Identity.
/// </summary>
public sealed class TvDefaultFollower
{
    private TvDefaultFollower()
    {
    }

    public Guid UserId { get; private set; }

    public DateTimeOffset CreatedAt { get; private set; }

    public static TvDefaultFollower Create(Guid userId, DateTimeOffset now) => new()
    {
        UserId = userId,
        CreatedAt = now,
    };
}
