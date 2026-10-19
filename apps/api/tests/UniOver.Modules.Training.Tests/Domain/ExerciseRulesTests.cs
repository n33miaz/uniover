using AwesomeAssertions;
using UniOver.Modules.Training.Domain;

namespace UniOver.Modules.Training.Tests.Domain;

public class ExerciseIdsTests
{
    // Vetor conhecido da RFC 9562 (seção 5.5 e apêndice A.4): uuid5(DNS, "www.example.com").
    private static readonly Guid DnsNamespace = Guid.Parse("6ba7b810-9dad-11d1-80b4-00c04fd430c8");

    [Fact]
    public void CreateV5_MatchesTheRfcTestVector()
    {
        ExerciseIds.CreateV5(DnsNamespace, "www.example.com")
            .Should().Be(Guid.Parse("2ed6657d-e927-568b-95e1-2665a8aea6a2"));
    }

    [Fact]
    public void ForCatalog_IsDeterministicAndVersionFive()
    {
        var a = ExerciseIds.ForCatalog("free_exercise_db", "Barbell_Curl");
        var b = ExerciseIds.ForCatalog("free_exercise_db", "Barbell_Curl");

        a.Should().Be(b);
        a.ToString()[14].Should().Be('5');
    }

    [Fact]
    public void ForCatalog_DependsOnSourceAndReference()
    {
        var a = ExerciseIds.ForCatalog("free_exercise_db", "Barbell_Curl");

        ExerciseIds.ForCatalog("wger", "Barbell_Curl").Should().NotBe(a);
        ExerciseIds.ForCatalog("free_exercise_db", "Dumbbell_Curl").Should().NotBe(a);
    }

    [Fact]
    public void ForCatalog_NeverChanges_BecauseDevicesAndRoutinesReferenceTheId()
    {
        // Valores calculados à parte (uuid5 da biblioteca padrão do Python): mudar o namespace do catálogo mudaria todos
        // os ids de todos os ambientes, e o aparelho, a rotina e o histórico referenciam esses ids.
        ExerciseIds.ForCatalog("free_exercise_db", "Barbell_Curl").Should().Be(Guid.Parse("2b8dc14e-415d-52d8-8e8d-8b157eea96a5"));
        ExerciseIds.ForCatalog("wger", "aaaaaaaa-0000-4000-8000-000000000001").Should().Be(Guid.Parse("490c34f0-a40d-5841-b315-23145de86771"));
    }

    [Theory]
    [InlineData("", "x")]
    [InlineData("free_exercise_db", " ")]
    public void ForCatalog_RejectsEmptyParts(string source, string reference)
    {
        var act = () => ExerciseIds.ForCatalog(source, reference);

        act.Should().Throw<ArgumentException>();
    }
}

public class LastWriterWinsTests
{
    private static readonly DateTimeOffset Now = new(2026, 10, 19, 12, 0, 0, TimeSpan.Zero);

    [Fact]
    public void NewerWrite_IsApplied()
    {
        LastWriterWins.ShouldApply(Now.AddSeconds(1), Now).Should().BeTrue();
    }

    [Fact]
    public void OlderWrite_IsIgnored()
    {
        LastWriterWins.ShouldApply(Now.AddSeconds(-1), Now).Should().BeFalse();
    }

    [Fact]
    public void EqualWrite_IsAppliedAgain_SoTheIdempotentResendLandsHere()
    {
        LastWriterWins.ShouldApply(Now, Now).Should().BeTrue();
    }

    [Fact]
    public void ANewerTombstone_BeatsAnOlderEdit_BecauseTheRuleIsTheSameForBoth()
    {
        // A lápide é uma escrita como as outras: quem tem o relógio mais novo vence.
        var storedEdit = Now;
        var tombstone = Now.AddMinutes(5);

        LastWriterWins.ShouldApply(tombstone, storedEdit).Should().BeTrue();
        LastWriterWins.ShouldApply(storedEdit, tombstone).Should().BeFalse();
    }

    [Fact]
    public void ClockMoreThan24HoursAhead_IsRefused()
    {
        LastWriterWins.IsClockAhead(Now.AddHours(24).AddSeconds(1), Now).Should().BeTrue();
    }

    [Fact]
    public void ClockUpTo24HoursAhead_IsAccepted()
    {
        LastWriterWins.IsClockAhead(Now.AddHours(24), Now).Should().BeFalse();
        LastWriterWins.IsClockAhead(Now.AddHours(-48), Now).Should().BeFalse();
    }
}

public class TimeStampsTests
{
    [Fact]
    public void ToStorage_TruncatesToMicroseconds_LikePostgres()
    {
        var value = new DateTimeOffset(2026, 10, 19, 12, 0, 0, TimeSpan.Zero).AddTicks(1234567);

        var stored = TimeStamps.ToStorage(value);

        stored.UtcTicks.Should().Be(value.UtcTicks - (value.UtcTicks % 10));
        stored.Offset.Should().Be(TimeSpan.Zero);
    }
}
