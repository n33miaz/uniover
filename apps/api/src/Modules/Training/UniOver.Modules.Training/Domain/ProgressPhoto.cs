namespace UniOver.Modules.Training.Domain;

/// <summary>Metadados de uma foto de progresso; o objeto permanece privado fora do banco.</summary>
internal sealed class ProgressPhoto
{
    public Guid Id { get; set; }
    public Guid UserId { get; set; }
    public DateOnly TakenOn { get; set; }
    public string ObjectKey { get; set; } = string.Empty;
    public int Width { get; set; }
    public int Height { get; set; }
    public long ByteLength { get; set; }
    public string Sha256 { get; set; } = string.Empty;
    public string State { get; set; } = "pending";
    public DateTimeOffset CreatedAt { get; set; }
    public DateTimeOffset? DeletedAt { get; set; }
}
