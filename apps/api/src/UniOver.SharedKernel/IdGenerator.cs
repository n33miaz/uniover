namespace UniOver.SharedKernel;

/// <summary>UUID v7: ordenável por tempo, bom para índices e sem coordenação entre módulos.</summary>
public static class IdGenerator
{
    public static Guid NewId() => Guid.CreateVersion7();
}
