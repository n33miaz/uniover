namespace UniOver.Modules.Tv.Domain;

/// <summary>Preferências comuns de uma TV, definidas pelo dono. A vibração pertence ao aparelho.</summary>
public sealed class TvLayout
{
    private TvLayout()
    {
    }

    public Guid TvId { get; private set; }

    public string Document { get; private set; } = string.Empty;

    public DateTimeOffset UpdatedAt { get; private set; }
}
