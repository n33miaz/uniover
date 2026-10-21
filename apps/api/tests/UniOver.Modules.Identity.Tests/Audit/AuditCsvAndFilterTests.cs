using System.Text;
using AwesomeAssertions;
using UniOver.Modules.Identity.Audit;
using UniOver.Modules.Identity.Features.ListAudit;
using UniOver.SharedKernel.Audit;

namespace UniOver.Modules.Identity.Tests.Audit;

public class AuditCsvTests
{
    [Theory]
    [InlineData("=1+1", "'=1+1")]
    [InlineData("+cmd", "'+cmd")]
    [InlineData("-2+3", "'-2+3")]
    [InlineData("@SUM(A1)", "'@SUM(A1)")]
    [InlineData("\tabc", "'\tabc")]
    [InlineData("\rabc", "\"'\rabc\"")]
    public void Cell_NeutralizesFormulaPrefixes(string value, string expected)
    {
        AuditCsv.Cell(value).Should().Be(expected);
    }

    [Fact]
    public void Cell_QuotesWhenNeeded_AndDoublesTheQuotes()
    {
        AuditCsv.Cell("simples").Should().Be("simples");
        AuditCsv.Cell("a,b").Should().Be("\"a,b\"");
        AuditCsv.Cell("diz \"oi\"").Should().Be("\"diz \"\"oi\"\"\"");
        AuditCsv.Cell("duas\nlinhas").Should().Be("\"duas\nlinhas\"");
        AuditCsv.Cell(null).Should().BeEmpty();
        AuditCsv.Cell(string.Empty).Should().BeEmpty();
    }

    [Fact]
    public void Cell_ANastyUserAgent_IsBothQuotedAndDefused()
    {
        AuditCsv.Cell("=HYPERLINK(\"http://x\",\"clique\")")
            .Should().Be("\"'=HYPERLINK(\"\"http://x\"\",\"\"clique\"\")\"");
    }

    [Fact]
    public void Write_StartsWithByteOrderMark_UsesCrLf_AndHasTheHeaderFirst()
    {
        var item = new AuditItem(
            Guid.Parse("11111111-1111-7111-8111-111111111111"),
            "tv",
            "tv.key",
            "success",
            new DateTimeOffset(2026, 10, 21, 12, 30, 45, 123, TimeSpan.FromHours(-3)),
            new AuditAccount(Guid.Parse("22222222-2222-7222-8222-222222222222"), "Ana, a primeira"),
            "VOLUME_UP",
            null,
            null,
            "203.0.113.7",
            "=cmd|' /C calc'!A0");

        var bytes = AuditCsv.Write([item]);

        bytes[..3].Should().Equal(0xEF, 0xBB, 0xBF);
        var lines = Encoding.UTF8.GetString(bytes[3..]).Split("\r\n");
        lines[0].Should().Be(string.Join(',', AuditCsv.Header));
        lines[1].Should().Be(
            "2026-10-21T15:30:45.123000Z,tv,tv.key,success,22222222-2222-7222-8222-222222222222,\"Ana, a primeira\",VOLUME_UP,,,,203.0.113.7,'=cmd|' /C calc'!A0");
        lines[2].Should().BeEmpty("a última linha também termina com quebra");
    }
}

public class AuditFilterParserTests
{
    private static readonly string[] Known = ["identity", "devices", "tv"];

    private static (AuditFilter? Filter, Dictionary<string, string[]> Errors) Parse(
        string? from = null,
        string? to = null,
        string? person = null,
        string[]? modules = null,
        string[]? actions = null,
        string? outcome = null) =>
        AuditFilterParser.Parse(from, to, person, modules, actions, outcome, Known);

    [Fact]
    public void NothingGiven_MeansNoFilter()
    {
        var (filter, errors) = Parse();

        errors.Should().BeEmpty();
        filter.Should().NotBeNull();
        filter!.From.Should().BeNull();
        filter.Modules.Should().BeEmpty();
        filter.Actions.Should().BeEmpty();
        filter.Outcome.Should().BeNull();
    }

    [Fact]
    public void ValidValues_AreParsed_AndInstantsWithoutOffsetAreUtc()
    {
        var person = Guid.NewGuid();

        var (filter, errors) = Parse(
            "2026-10-01T00:00:00", "2026-10-21T12:00:00-03:00", person.ToString(), ["tv", "tv"], ["tv.key", "login_failed"], "failure");

        errors.Should().BeEmpty();
        filter!.From.Should().Be(new DateTimeOffset(2026, 10, 1, 0, 0, 0, TimeSpan.Zero));
        filter.To.Should().Be(new DateTimeOffset(2026, 10, 21, 15, 0, 0, TimeSpan.Zero));
        filter.PersonId.Should().Be(person);
        filter.Modules.Should().Equal("tv");
        filter.Actions.Should().Equal("tv.key", "login_failed");
        filter.Outcome.Should().Be(AuditOutcome.Failure);
    }

    [Theory]
    [InlineData("ontem", null, "from")]
    [InlineData(null, "32/13/2026", "to")]
    [InlineData("2026-10-21T12:00:00Z", "2026-10-21T12:00:00Z", "to")]
    [InlineData("2026-10-22T00:00:00Z", "2026-10-21T00:00:00Z", "to")]
    public void BadPeriod_IsRefused(string? from, string? to, string field)
    {
        var (filter, errors) = Parse(from, to);

        filter.Should().BeNull();
        errors.Should().ContainKey(field);
    }

    [Fact]
    public void BadValues_AreRefused_AndTheMessageNeverEchoesWhatWasSent()
    {
        var sent = "<script>alert(1)</script>";

        var (filter, errors) = Parse(person: sent, modules: ["Tv; DROP"], actions: [sent], outcome: sent);

        filter.Should().BeNull();
        errors.Keys.Should().BeEquivalentTo("person", "module", "action", "outcome");
        errors.Values.SelectMany(v => v).Should().OnlyContain(message => !message.Contains("script", StringComparison.Ordinal));
    }

    [Fact]
    public void UnknownModule_IsRefused()
    {
        var (_, errors) = Parse(modules: ["training"]);

        errors.Should().ContainKey("module");
    }

    [Fact]
    public void TooManyCodes_AreRefused()
    {
        var many = Enumerable.Range(0, AuditFilterParser.MaxListItems + 1).Select(i => $"a{i}").ToArray();

        var (_, errors) = Parse(actions: many);

        errors.Should().ContainKey("action");
    }

    [Theory]
    [InlineData(null, true, 50)]
    [InlineData(1, true, 1)]
    [InlineData(200, true, 200)]
    [InlineData(0, false, 0)]
    [InlineData(201, false, 201)]
    [InlineData(-5, false, -5)]
    public void Limit_DefaultsTo50_AndStaysBetween1And200(int? limit, bool valid, int expected)
    {
        var errors = new Dictionary<string, string[]>();

        AuditFilterParser.TryLimit(limit, out var value, errors).Should().Be(valid);

        value.Should().Be(expected);
        errors.ContainsKey("limit").Should().Be(!valid);
    }
}
