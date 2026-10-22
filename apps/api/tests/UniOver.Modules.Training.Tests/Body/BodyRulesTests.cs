using AwesomeAssertions;
using UniOver.Modules.Training.Domain.Body;
using UniOver.Modules.Training.Features.Body.PullBodyEntries;
using UniOver.Modules.Training.Features.Body.UpsertBodyEntry;
using UniOver.Modules.Training.Features.Body.UpsertBodyProfile;

namespace UniOver.Modules.Training.Tests.Body;

public class BodyRulesTests
{
    private static readonly Guid UserId = Guid.Parse("11111111-1111-1111-1111-111111111111");
    private static readonly Guid EntryId = Guid.Parse("0192f1e4-7a10-7c3f-8d44-0123456789ab");
    private static readonly DateTimeOffset Stamp = new(2026, 10, 19, 12, 0, 0, TimeSpan.Zero);
    private static readonly DateOnly Today = new(2026, 10, 19);

    private static UpsertBodyEntryRequest ValidEntry() => new(
        MeasuredOn: Today, WeightKg: 82.4m, BodyFatPct: null, FatMethod: null, WaistCm: null, NeckCm: null, HipCm: null,
        ArmCm: null, ThighCm: null, Note: null, ClientUpdatedAt: Stamp, Deleted: false);

    private static Dictionary<string, string[]> RunEntry(UpsertBodyEntryRequest? request, out UpsertBodyEntryCommand? command, Guid? id = null) =>
        UpsertBodyEntryValidator.Validate(id ?? EntryId, request, UserId, Today, out command);

    private static UpsertBodyProfileRequest ValidProfile() => new(
        HeightCm: 180m, BirthDate: new DateOnly(1995, 6, 15), Sex: "male", ActivityFactor: 1.55m, ClientUpdatedAt: Stamp);

    private static Dictionary<string, string[]> RunProfile(UpsertBodyProfileRequest? request, out UpsertBodyProfileCommand? command) =>
        UpsertBodyProfileValidator.Validate(request, UserId, Today, out command);

    [Fact]
    public void StableValues_AreTheOnesTheDeviceAndTheDatabaseKnow()
    {
        FatMethods.All.Should().Equal("navy", "manual", "bioimpedance");
        BodySexes.All.Should().Equal("male", "female");
        FatMethods.IsValid("navy").Should().BeTrue();
        FatMethods.IsValid("dobras").Should().BeFalse();
        FatMethods.IsValid(null).Should().BeFalse();
        BodySexes.IsValid("female").Should().BeTrue();
        BodySexes.IsValid("x").Should().BeFalse();
        BodyLimits.ActivityFactorDefault.Should().Be(1.55m);
    }

    [Theory]
    [InlineData(20, true)]
    [InlineData(400, true)]
    [InlineData(82.45, true)]
    [InlineData(19.99, false)]
    [InlineData(400.01, false)]
    [InlineData(82.456, false)]
    public void Weight_IsLimitedAndHasTwoDecimalsAtMost(double value, bool valid) =>
        BodyLimits.IsValidWeight((decimal)value).Should().Be(valid);

    [Theory]
    [InlineData(2, true)]
    [InlineData(70, true)]
    [InlineData(16.9, true)]
    [InlineData(1.9, false)]
    [InlineData(70.1, false)]
    [InlineData(16.95, false)]
    public void BodyFat_IsLimitedAndHasOneDecimalAtMost(double value, bool valid) =>
        BodyLimits.IsValidBodyFat((decimal)value).Should().Be(valid);

    [Theory]
    [InlineData(10, true)]
    [InlineData(250, true)]
    [InlineData(86.5, true)]
    [InlineData(9.9, false)]
    [InlineData(250.1, false)]
    [InlineData(86.25, false)]
    public void Circumference_IsLimitedAndHasOneDecimalAtMost(double value, bool valid) =>
        BodyLimits.IsValidCircumference((decimal)value).Should().Be(valid);

    [Theory]
    [InlineData(100, true)]
    [InlineData(250, true)]
    [InlineData(99.9, false)]
    [InlineData(250.1, false)]
    [InlineData(180.55, false)]
    public void Height_IsLimitedAndHasOneDecimalAtMost(double value, bool valid) =>
        BodyLimits.IsValidHeight((decimal)value).Should().Be(valid);

    [Theory]
    [InlineData(1.0, true)]
    [InlineData(2.5, true)]
    [InlineData(1.55, true)]
    [InlineData(0.99, false)]
    [InlineData(2.51, false)]
    [InlineData(1.555, false)]
    public void ActivityFactor_IsLimitedAndHasTwoDecimalsAtMost(double value, bool valid) =>
        BodyLimits.IsValidActivityFactor((decimal)value).Should().Be(valid);

    [Fact]
    public void ValidEntry_BecomesANormalizedCommand()
    {
        var errors = RunEntry(
            ValidEntry() with { Note = "  de manhã  ", BodyFatPct = 16.9m, FatMethod = "navy", WaistCm = 86m }, out var command);

        errors.Should().BeEmpty();
        command!.Note.Should().Be("de manhã");
        command.UserId.Should().Be(UserId);
        command.Id.Should().Be(EntryId);
        command.FatMethod.Should().Be("navy");
        command.ClientUpdatedAt.Should().Be(Stamp);
        command.HasAnyValue.Should().BeTrue();
    }

    [Fact]
    public void BlankNote_BecomesNull_AndTheNoteAloneIsNotAValue()
    {
        RunEntry(ValidEntry() with { WeightKg = null, Note = "   " }, out var command).Should().BeEmpty();

        command!.Note.Should().BeNull();
        command.HasAnyValue.Should().BeFalse("a anotação sozinha não conta; quem recusa a medição vazia é o endpoint (422)");
    }

    [Fact]
    public void MissingBody_IdClockOrDate_AreRefused()
    {
        RunEntry(null, out var command).Should().ContainKey("body");
        command.Should().BeNull();
        RunEntry(ValidEntry(), out _, Guid.Empty).Should().ContainKey("id");
        RunEntry(ValidEntry() with { ClientUpdatedAt = null }, out _).Should().ContainKey("clientUpdatedAt");
        RunEntry(ValidEntry() with { MeasuredOn = null }, out _).Should().ContainKey("measuredOn");
    }

    [Fact]
    public void MeasuredOn_AllowsOneDayAheadOfTheServerDate_AndNotBefore1900()
    {
        RunEntry(ValidEntry() with { MeasuredOn = Today.AddDays(1) }, out _).Should().BeEmpty();
        RunEntry(ValidEntry() with { MeasuredOn = Today.AddDays(2) }, out _).Should().ContainKey("measuredOn");
        RunEntry(ValidEntry() with { MeasuredOn = new DateOnly(1900, 1, 1) }, out _).Should().BeEmpty();
        RunEntry(ValidEntry() with { MeasuredOn = new DateOnly(1899, 12, 31) }, out _).Should().ContainKey("measuredOn");
    }

    [Fact]
    public void EachValueOutOfLimits_NamesItsFieldAndNeverRepeatsTheValue()
    {
        var errors = RunEntry(
            ValidEntry() with
            {
                WeightKg = 19.5m, BodyFatPct = 71.5m, FatMethod = "manual", WaistCm = 9.5m, NeckCm = 251.5m, HipCm = 0.5m, ArmCm = 300.5m, ThighCm = -2.5m,
            },
            out var command);

        command.Should().BeNull();
        errors.Keys.Should().BeEquivalentTo("weightKg", "bodyFatPct", "waistCm", "neckCm", "hipCm", "armCm", "thighCm");
        string.Concat(errors.Values.SelectMany(v => v)).Should().NotContain("19.5").And.NotContain("71.5").And.NotContain("251.5");
    }

    [Fact]
    public void TheFatMethod_GoesWithThePercentAndOnlyWithIt()
    {
        RunEntry(ValidEntry() with { BodyFatPct = 15m, FatMethod = null }, out _).Should().ContainKey("fatMethod");
        RunEntry(ValidEntry() with { BodyFatPct = 15m, FatMethod = "dobras" }, out _).Should().ContainKey("fatMethod");
        RunEntry(ValidEntry() with { BodyFatPct = null, FatMethod = "navy" }, out _).Should().ContainKey("fatMethod");
        foreach (var method in FatMethods.All)
        {
            RunEntry(ValidEntry() with { BodyFatPct = 15m, FatMethod = method }, out _).Should().BeEmpty(method);
        }
    }

    [Fact]
    public void NoteLimit_IsEnforced()
    {
        RunEntry(ValidEntry() with { Note = new string('a', BodyLimits.NoteMax + 1) }, out _).Should().ContainKey("note");
        RunEntry(ValidEntry() with { Note = new string('a', BodyLimits.NoteMax) }, out _).Should().BeEmpty();
    }

    [Fact]
    public void ValidProfile_BecomesACommand_AndTheActivityFactorDefaultsTo155()
    {
        RunProfile(ValidProfile(), out var command).Should().BeEmpty();
        command!.UserId.Should().Be(UserId);
        command.Sex.Should().Be("male");
        command.ActivityFactor.Should().Be(1.55m);

        RunProfile(ValidProfile() with { ActivityFactor = null }, out var defaulted).Should().BeEmpty();
        defaulted!.ActivityFactor.Should().Be(1.55m);
    }

    [Fact]
    public void Profile_RequiresHeightBirthDateSexAndClock_AndChecksTheirLimits()
    {
        RunProfile(null, out _).Should().ContainKey("body");
        RunProfile(ValidProfile() with { HeightCm = null }, out _).Should().ContainKey("heightCm");
        RunProfile(ValidProfile() with { HeightCm = 99.9m }, out _).Should().ContainKey("heightCm");
        RunProfile(ValidProfile() with { BirthDate = null }, out _).Should().ContainKey("birthDate");
        RunProfile(ValidProfile() with { BirthDate = Today.AddDays(1) }, out _).Should().ContainKey("birthDate");
        RunProfile(ValidProfile() with { BirthDate = new DateOnly(1899, 12, 31) }, out _).Should().ContainKey("birthDate");
        RunProfile(ValidProfile() with { Sex = null }, out _).Should().ContainKey("sex");
        RunProfile(ValidProfile() with { Sex = "outro" }, out _).Should().ContainKey("sex");
        RunProfile(ValidProfile() with { ActivityFactor = 2.6m }, out _).Should().ContainKey("activityFactor");
        RunProfile(ValidProfile() with { ClientUpdatedAt = null }, out _).Should().ContainKey("clientUpdatedAt");
    }

    [Fact]
    public void AMinor_IsNotRefusedAtTheEdge_BecauseTheRegistrationIsFree()
    {
        RunProfile(ValidProfile() with { BirthDate = Today.AddYears(-10) }, out var command).Should().BeEmpty();

        command.Should().NotBeNull();
    }

    [Theory]
    [InlineData(null, null, true)]
    [InlineData("não é cursor", null, false)]
    [InlineData(null, 0, false)]
    [InlineData(null, 501, false)]
    [InlineData(null, 500, true)]
    public void PullPage_ValidatesTheCursorAndTheLimit(string? after, int? limit, bool valid) =>
        PullBodyValidator.Validate(after, limit, out _, out _).Should().HaveCount(valid ? 0 : 1);
}
