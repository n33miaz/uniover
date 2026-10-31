using System.Text.Json.Serialization;

namespace UniOver.Modules.Tv.Features.TvLivre;

// Os textos de enumeração viajam como texto (não como enum do C#) de propósito: o valor inválido precisa virar uma
// mensagem por campo, e não um erro genérico de leitura do corpo. Campo desconhecido é recusado (Disallow): quem escreve
// a configuração que vai para a TV não pode ser tolerante como o launcher é ao ler. As seis seções são obrigatórias (o JSON
// com seção ausente ou nula é recusado por campo no validador), por isso o tipo as declara sem nulo.

/// <summary>O que o dono configura no TV Livre: relógio, fundo, apps, ícones, atalhos embutidos e o Modo Dormir.</summary>
[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
internal sealed record LivreConfig(
    LivreClock Clock, LivreWallpaper Wallpaper, LivreApps Apps, LivreIcons Icons, LivreBuiltin Builtin, LivreSleep Sleep)
{
    /// <summary>
    /// O padrão da home aprovada: relógio grande de 24 h com data, degradê azul-noite a roxo na diagonal e, nos apps,
    /// <c>all</c> com a lista vazia e os de fábrica ocultos. Não é <c>listed</c> de propósito: com a lista vazia o
    /// launcher mostra TODOS os apps (rede de segurança dele), então "tudo que não é de fábrica" só se pede em <c>all</c>.
    /// </summary>
    public static LivreConfig Default { get; } = new(
        new LivreClock(true, "large", "24h", false, true),
        new LivreWallpaper("gradient", ["#1B2440", "#3A2D5C"], 315, 0.25),
        new LivreApps("all", [], [], false),
        new LivreIcons("medium", "always"),
        new LivreBuiltin(true, false),
        new LivreSleep(0));
}

/// <param name="Size"><c>large</c>, <c>medium</c> ou <c>small</c>.</param>
/// <param name="Format"><c>24h</c>, <c>12h</c> ou <c>auto</c> (o formato do sistema da TV).</param>
[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
internal sealed record LivreClock(bool Enabled = true, string Size = "large", string Format = "24h", bool Seconds = false, bool Date = true);

/// <param name="Type"><c>gradient</c>, <c>solid</c> ou <c>photo</c>.</param>
/// <param name="Colors">De 1 a 3 cores <c>#RRGGBB</c>; na foto servem de fundo se ela faltar.</param>
/// <param name="Angle">Múltiplo de 45 de 0 a 315, como no Android (anti-horário a partir da direita).</param>
/// <param name="Dim">Escurecimento por cima do fundo, de 0 a 0,8.</param>
[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
internal sealed record LivreWallpaper(
    string Type = "gradient", IReadOnlyList<string>? Colors = null,
    [property: JsonNumberHandling(JsonNumberHandling.Strict)] int Angle = 315,
    [property: JsonNumberHandling(JsonNumberHandling.Strict)] double Dim = 0.25);

/// <param name="Mode"><c>listed</c> (só os de <paramref name="Items"/>) ou <c>all</c>.</param>
[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
internal sealed record LivreApps(
    string Mode = "all", IReadOnlyList<string>? Items = null, IReadOnlyList<string>? Hidden = null, bool ShowFactory = false);

/// <param name="Size"><c>small</c>, <c>medium</c> ou <c>large</c>.</param>
/// <param name="Labels"><c>always</c>, <c>focus</c> ou <c>never</c>.</param>
[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
internal sealed record LivreIcons(string Size = "medium", string Labels = "always");

[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
internal sealed record LivreBuiltin(bool Settings = true, bool Sleep = false);

/// <param name="MaxMinutes">Sai do Modo Dormir sozinho depois deste tempo (0 a 720); 0 só acorda com tecla.</param>
[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
internal sealed record LivreSleep([property: JsonNumberHandling(JsonNumberHandling.Strict)] int MaxMinutes = 0);
