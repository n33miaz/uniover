using System.Globalization;
using System.Text;
using AwesomeAssertions;
using UniOver.SharedKernel.Audit;

namespace UniOver.IntegrationTests.Audit;

/// <summary>A posição composta da trilha unificada: formato do cursor e a ordem total (instante, fonte, id). Sem banco.</summary>
public class AuditCursorTests
{
    private static readonly DateTimeOffset At = new(2026, 10, 21, 12, 0, 0, TimeSpan.Zero);

    private static AuditRecord Record(string module, DateTimeOffset at, Guid id) => new(
        id, at, module, "acao", null, null, null, AuditOutcome.Success, null, null, null);

    [Fact]
    public void Encode_ThenDecode_RoundTripsWithoutLosingPrecision()
    {
        // O instante do banco tem microssegundos; o cursor precisa devolvê-lo idêntico.
        var at = At.AddTicks(1234560);
        var id = Guid.NewGuid();
        var cursor = new AuditCursor(at, "tv", id);

        AuditCursor.TryDecode(cursor.Encode(), out var decoded).Should().BeTrue();

        decoded.Should().Be(cursor);
        decoded!.OccurredAt.UtcTicks.Should().Be(at.UtcTicks);
        decoded.OccurredAt.Offset.Should().Be(TimeSpan.Zero, "o Npgsql só aceita timestamptz em UTC");
    }

    [Fact]
    public void AnInstantWithAnOffset_IsStoredAsUtc()
    {
        var cursor = new AuditCursor(new DateTimeOffset(2026, 10, 21, 9, 0, 0, TimeSpan.FromHours(-3)), "tv", Guid.NewGuid());

        cursor.OccurredAt.Should().Be(At);
        cursor.OccurredAt.Offset.Should().Be(TimeSpan.Zero);
    }

    [Fact]
    public void Encoded_IsUrlSafe()
    {
        var text = new AuditCursor(At, "identity", Guid.NewGuid()).Encode();

        text.Should().MatchRegex("^[A-Za-z0-9_-]+$");
    }

    private static string Encoded(string payload) =>
        Convert.ToBase64String(Encoding.UTF8.GetBytes(payload)).TrimEnd('=').Replace('+', '-').Replace('/', '_');

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("isso não é base64!")]
    [InlineData("AAAA")]
    public void Garbage_IsRefusedWithoutThrowing(string? text)
    {
        AuditCursor.TryDecode(text, out var cursor).Should().BeFalse();

        cursor.Should().BeNull();
    }

    [Fact]
    public void WrongShape_IsRefused()
    {
        var id = Guid.NewGuid().ToString("N");
        var ticks = At.UtcTicks.ToString(CultureInfo.InvariantCulture);

        AuditCursor.TryDecode(Encoded($"2|{ticks}|tv|{id}"), out _).Should().BeFalse("versão desconhecida");
        AuditCursor.TryDecode(Encoded($"1|{ticks}|tv"), out _).Should().BeFalse("faltam partes");
        AuditCursor.TryDecode(Encoded($"1|{ticks}|tv|{id}|extra"), out _).Should().BeFalse("partes demais");
        AuditCursor.TryDecode(Encoded($"1|-5|tv|{id}"), out _).Should().BeFalse("instante negativo");
        AuditCursor.TryDecode(Encoded($"1|99999999999999999999|tv|{id}"), out _).Should().BeFalse("instante fora do intervalo");
        AuditCursor.TryDecode(Encoded($"1|{ticks}|TV;|{id}"), out _).Should().BeFalse("nome de fonte fora do padrão");
        AuditCursor.TryDecode(Encoded($"1|{ticks}|tv|{Guid.NewGuid():D}"), out _).Should().BeFalse("id só no formato compacto");
        AuditCursor.TryDecode(Encoded($"1|{ticks}|tv|nao-e-um-guid"), out _).Should().BeFalse();
        AuditCursor.TryDecode(Encoded($"1|{ticks}|tv|{id}"), out var ok).Should().BeTrue("o formato certo passa");
        ok!.Module.Should().Be("tv");
    }

    [Fact]
    public void TooLongInput_IsRefusedBeforeAnyWork()
    {
        AuditCursor.TryDecode(new string('A', 500), out _).Should().BeFalse();
    }

    [Fact]
    public void ConstructorRejectsABadModuleName()
    {
        var act = () => new AuditCursor(At, "Tv; DROP", Guid.NewGuid());

        act.Should().Throw<ArgumentException>();
    }

    [Fact]
    public void Order_IsNewestFirst_ThenModuleDescending_ThenIdDescending()
    {
        var small = Guid.Parse("00000000-0000-7000-8000-000000000001");
        var big = Guid.Parse("ffffffff-0000-7000-8000-000000000001");
        var records = new List<AuditRecord>
        {
            Record("devices", At, small),
            Record("tv", At.AddSeconds(-1), small),
            Record("tv", At, big),
            Record("tv", At, small),
            Record("identity", At, small),
            Record("identity", At.AddSeconds(1), small),
        };

        records.Sort(AuditOrder.Newest);

        records.Select(r => (r.Module, r.OccurredAt.Second, r.Id == big)).Should().Equal(
            ("identity", 1, false),
            ("tv", 0, true),
            ("tv", 0, false),
            ("identity", 0, false),
            ("devices", 0, false),
            ("tv", 59, false));
    }

    [Fact]
    public void Order_ComparesIdsByTheCanonicalText_WhichIsTheOrderOfAPostgresUuid()
    {
        // O Postgres compara o uuid byte a byte a partir do primeiro; o texto canônico minúsculo ordena igual.
        var a = Guid.Parse("00000001-0000-7000-8000-000000000000");
        var b = Guid.Parse("00000002-0000-7000-8000-000000000000");
        var list = new List<AuditRecord> { Record("tv", At, a), Record("tv", At, b) };

        list.Sort(AuditOrder.Newest);

        list[0].Id.Should().Be(b, "uuid maior primeiro, na ordem do banco");
    }

    [Fact]
    public void TieRules_FollowTheModuleOrder()
    {
        var cursor = new AuditCursor(At, "devices", Guid.NewGuid());

        cursor.TieFor("devices").Should().Be(AuditTie.SameSource);
        cursor.TieFor("identity").Should().Be(AuditTie.ExcludeSameInstant, "identity sai antes de devices no mesmo instante");
        cursor.TieFor("tv").Should().Be(AuditTie.ExcludeSameInstant);
        cursor.TieFor("alpha").Should().Be(AuditTie.IncludeSameInstant);
    }

    /// <summary>
    /// A propriedade que importa: com muitas linhas no MESMO instante em várias fontes, "o que vem depois do cursor"
    /// pelas regras de cada fonte é exatamente o resto da lista ordenada, sem repetir nem pular ninguém.
    /// </summary>
    [Fact]
    public void WhatComesAfterACursor_IsExactlyTheRestOfTheSortedList_EvenWithManyTies()
    {
        var random = new Random(20261021);
        var modules = new[] { "devices", "identity", "tv" };
        var all = new List<AuditRecord>();
        foreach (var module in modules)
        {
            for (var i = 0; i < 25; i++)
            {
                // Só três instantes distintos: quase tudo empata.
                var bytes = new byte[16];
                random.NextBytes(bytes);
                all.Add(Record(module, At.AddSeconds(random.Next(0, 3)), new Guid(bytes)));
            }
        }

        var sorted = all.OrderBy(r => r, AuditOrder.Newest).ToList();

        for (var position = 0; position < sorted.Count; position++)
        {
            var cursor = AuditCursor.Of(sorted[position]);
            var after = modules
                .SelectMany(module => all.Where(r => r.Module == module && IsAfterForSource(r, cursor)))
                .OrderBy(r => r, AuditOrder.Newest)
                .ToList();

            after.Select(r => r.Id).Should().Equal(
                sorted.Skip(position + 1).Select(r => r.Id), $"posição {position} da lista ordenada");
        }
    }

    /// <summary>A mesma regra que cada fonte traduz para SQL, escrita em memória.</summary>
    private static bool IsAfterForSource(AuditRecord record, AuditCursor cursor) => cursor.TieFor(record.Module) switch
    {
        AuditTie.SameSource => record.OccurredAt < cursor.OccurredAt
            || (record.OccurredAt == cursor.OccurredAt
                && string.CompareOrdinal(record.Id.ToString("D", CultureInfo.InvariantCulture), cursor.Id.ToString("D", CultureInfo.InvariantCulture)) < 0),
        AuditTie.IncludeSameInstant => record.OccurredAt <= cursor.OccurredAt,
        _ => record.OccurredAt < cursor.OccurredAt,
    };
}
