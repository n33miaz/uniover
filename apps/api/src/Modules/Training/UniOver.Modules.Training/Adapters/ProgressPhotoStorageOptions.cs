using UniOver.Modules.Training.Features.ProgressPhotos;

namespace UniOver.Modules.Training.Adapters;

/// <summary>Limites e configuração de fotos de progresso, exclusivos do módulo Treino.</summary>
public sealed class ProgressPhotoOptions
{
    public const long DefaultMaxAccountBytes = 100L * 1024 * 1024;
    public const int DefaultMaxAccountPhotos = 500;

    public ProgressPhotoStorageOptions Storage { get; set; } = new();
    public long MaxAccountBytes { get; set; } = DefaultMaxAccountBytes;
    public int MaxAccountPhotos { get; set; } = DefaultMaxAccountPhotos;

    public bool IsValid() => Storage.IsValid() && MaxAccountBytes >= JpegPhotoValidator.MaxBytes && MaxAccountPhotos > 0;
}

/// <summary>Credenciais somente do servidor, injetadas por ambiente em Modules:Training:Photos:Storage.</summary>
public sealed class ProgressPhotoStorageOptions
{
    public bool Enabled { get; set; }
    public string ServiceUrl { get; set; } = string.Empty;
    public string Region { get; set; } = "us-east-2";
    public string Bucket { get; set; } = string.Empty;
    public string AccessKey { get; set; } = string.Empty;
    public string SecretKey { get; set; } = string.Empty;
    public bool IsValid() => !Enabled ||
        (Uri.TryCreate(ServiceUrl, UriKind.Absolute, out var uri) && uri.Scheme == Uri.UriSchemeHttps &&
         !string.IsNullOrWhiteSpace(Region) && !string.IsNullOrWhiteSpace(Bucket) &&
         !string.IsNullOrWhiteSpace(AccessKey) && !string.IsNullOrWhiteSpace(SecretKey));
}
