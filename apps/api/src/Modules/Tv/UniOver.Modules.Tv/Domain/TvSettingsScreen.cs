using System.Text.Json.Serialization;

namespace UniOver.Modules.Tv.Domain;

/// <summary>
/// A lista fechada de telas de configurações que a API sabe pedir à TV (<c>tv.settings.open.v1</c>). Viaja como texto com os
/// nomes do contrato (<c>WIFI</c>, <c>SETTINGS</c>), e é por ser enum que o OpenAPI (e o tipo gerado da web) a lista.
/// </summary>
[JsonConverter(typeof(JsonStringEnumConverter<TvSettingsScreen>))]
public enum TvSettingsScreen
{
    [JsonStringEnumMemberName("WIFI")]
    Wifi,

    [JsonStringEnumMemberName("SETTINGS")]
    Settings,
}

internal static class TvSettingsScreens
{
    /// <summary>O nome do contrato (e da trilha) de cada tela; valor fora da lista não tem nome.</summary>
    public static string WireName(TvSettingsScreen screen) => screen switch
    {
        TvSettingsScreen.Wifi => "WIFI",
        TvSettingsScreen.Settings => "SETTINGS",
        _ => throw new ArgumentOutOfRangeException(nameof(screen), "Tela fora da lista fechada."),
    };
}
