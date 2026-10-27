namespace UniOver.Modules.Identity.Domain;

/// <summary>Uma chave do catálogo alterada pelo dono. O valor tem forma canônica definida na borda.</summary>
public sealed class SystemSetting
{
    public string Key { get; set; } = string.Empty;
    public string ValueJson { get; set; } = string.Empty;
    public Guid UpdatedBy { get; set; }
    public DateTimeOffset UpdatedAt { get; set; }
}
