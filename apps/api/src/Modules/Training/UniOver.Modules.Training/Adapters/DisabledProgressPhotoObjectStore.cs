using UniOver.Modules.Training.Ports;

namespace UniOver.Modules.Training.Adapters;

internal sealed class DisabledProgressPhotoObjectStore : IProgressPhotoObjectStore
{
    public bool IsAvailable => false;

    private static InvalidOperationException Disabled() => new("Armazenamento de fotos não configurado.");
    public Task PutAsync(string key, ReadOnlyMemory<byte> content, CancellationToken cancellationToken) => throw Disabled();
    public Task<Stream?> OpenReadAsync(string key, CancellationToken cancellationToken) => throw Disabled();
    public Task DeleteAsync(string key, CancellationToken cancellationToken) => throw Disabled();
}
