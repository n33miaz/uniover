namespace UniOver.Modules.Training.Ports;

/// <summary>Armazenamento privado. O consumidor nunca recebe URL de acesso permanente.</summary>
internal interface IProgressPhotoObjectStore
{
    bool IsAvailable { get; }
    Task PutAsync(string key, ReadOnlyMemory<byte> content, CancellationToken cancellationToken);
    Task<Stream?> OpenReadAsync(string key, CancellationToken cancellationToken);
    Task DeleteAsync(string key, CancellationToken cancellationToken);
}
