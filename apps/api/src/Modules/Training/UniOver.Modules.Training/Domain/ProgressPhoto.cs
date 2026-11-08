namespace UniOver.Modules.Training.Domain;

/// <summary>
/// Resíduo de schema da nuvem de fotos de progresso, aposentada: nenhuma rota, handler nem armazenamento de objetos a usa.
/// O mapeamento fica só para o modelo continuar igual ao banco; a tabela sai numa migration própria de contração
/// (as migrations seguem o padrão expandir/contrair e nunca apagam dados na mesma entrega que para de usá-los).
/// </summary>
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
