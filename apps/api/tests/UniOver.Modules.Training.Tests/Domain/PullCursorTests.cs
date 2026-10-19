using AwesomeAssertions;
using UniOver.Modules.Training.Domain;

namespace UniOver.Modules.Training.Tests.Domain;

public class PullCursorTests
{
    private static readonly DateTimeOffset Stamp = new DateTimeOffset(2026, 10, 19, 12, 0, 0, TimeSpan.Zero).AddTicks(1230);
    private static readonly Guid Id = Guid.Parse("0192f1e4-7a10-7c3f-8d44-0123456789ab");

    [Fact]
    public void EncodeThenDecode_ReturnsTheSamePair()
    {
        var text = new PullCursor(Stamp, Id).Encode();

        PullCursor.TryDecode(text, out var cursor).Should().BeTrue();
        cursor.UpdatedAt.Should().Be(Stamp);
        cursor.Id.Should().Be(Id);
    }

    [Fact]
    public void Encode_IsUrlSafe_AndOpaque()
    {
        var text = new PullCursor(Stamp, Id).Encode();

        text.Should().MatchRegex("^[A-Za-z0-9_-]+$");
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("não é base64")]
    [InlineData("YWJj")]
    [InlineData("MTIzfG5vdC1hLWd1aWQ")]
    public void TryDecode_RefusesAnythingThatIsNotACursor(string? text)
    {
        PullCursor.TryDecode(text, out _).Should().BeFalse();
    }

    [Fact]
    public void TryDecode_RefusesATooLongText()
    {
        PullCursor.TryDecode(new string('A', 500), out _).Should().BeFalse();
    }

    [Fact]
    public void TryDecode_RefusesTicksBeyondTheRepresentableRange()
    {
        var huge = Convert.ToBase64String(System.Text.Encoding.UTF8.GetBytes($"{long.MaxValue}|{Id:D}"))
            .TrimEnd('=').Replace('+', '-').Replace('/', '_');

        PullCursor.TryDecode(huge, out _).Should().BeFalse();
    }

    [Fact]
    public void Limits_AreTwoHundredByDefaultAndFiveHundredAtMost()
    {
        PullCursor.DefaultLimit.Should().Be(200);
        PullCursor.MaxLimit.Should().Be(500);
    }
}
