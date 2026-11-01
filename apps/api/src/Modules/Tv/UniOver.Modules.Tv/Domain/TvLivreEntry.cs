namespace UniOver.Modules.Tv.Domain;

/// <summary>
/// O TV Livre de uma TV (uma linha por TV): a configuração que o dono montou, a foto do fundo, o número da última
/// aplicação e o último estado que o agente relatou. A linha nasce quando algo é guardado ou quando o primeiro estado
/// chega, e nunca é apagada por conta própria: o dono pode voltar ao original e a configuração dele continua aqui.
/// </summary>
public sealed class TvLivreEntry
{
    /// <summary>A foto vai em JPEG já reduzido pelo navegador; este teto também vale no agente.</summary>
    public const int PhotoMaxBytes = 400 * 1024;

    public const int PhotoSha256Length = 64;

    private TvLivreEntry()
    {
    }

    /// <summary>Id da TV. Sem FK de propósito, como o resto do módulo; <c>Guid.Empty</c> é a TV da instalação antiga sem linha salva.</summary>
    public Guid TvId { get; private set; }

    /// <summary>A <c>LivreConfig</c> guardada, já validada (JSON). Nulo até o dono salvar a primeira vez: vale o padrão.</summary>
    public string? ConfigJson { get; private set; }

    /// <summary>JPEG do fundo (até <see cref="PhotoMaxBytes"/>) e o sha256 dele em hexadecimal minúsculo.</summary>
    public byte[]? PhotoData { get; private set; }

    public string? PhotoSha256 { get; private set; }

    /// <summary>
    /// Número da última aplicação enviada à TV. O launcher só aceita um número maior que o que já tem, então ele é
    /// reservado no banco, atomicamente (<c>TvLivreStore.NextRevisionAsync</c>), antes de o comando sair:
    /// um comando que estourou o prazo mas chegou à TV nunca faz o número voltar, e duas aplicações nunca usam o mesmo.
    /// </summary>
    public int Revision { get; private set; }

    /// <summary>Último corpo de <c>tv.livre.state.v1</c> (JSON) e o pedido a que ele respondeu.</summary>
    public string? StateJson { get; private set; }

    public Guid? StateRequestId { get; private set; }

    public DateTimeOffset? StateAt { get; private set; }

    public DateTimeOffset UpdatedAt { get; private set; }

    public static TvLivreEntry Create(Guid tvId, DateTimeOffset now) => new() { TvId = tvId, UpdatedAt = now };

    public void SaveConfig(string configJson, DateTimeOffset now)
    {
        ArgumentException.ThrowIfNullOrEmpty(configJson);
        ConfigJson = configJson;
        UpdatedAt = now;
    }

    public void SavePhoto(byte[] data, string sha256, DateTimeOffset now)
    {
        ArgumentNullException.ThrowIfNull(data);
        ArgumentException.ThrowIfNullOrEmpty(sha256);
        PhotoData = data;
        PhotoSha256 = sha256;
        UpdatedAt = now;
    }

    public void RemovePhoto(DateTimeOffset now)
    {
        PhotoData = null;
        PhotoSha256 = null;
        UpdatedAt = now;
    }

    public void SaveState(string stateJson, Guid requestId, DateTimeOffset at, DateTimeOffset now)
    {
        ArgumentException.ThrowIfNullOrEmpty(stateJson);
        StateJson = stateJson;
        StateRequestId = requestId;
        StateAt = at;
        UpdatedAt = now;
    }
}
