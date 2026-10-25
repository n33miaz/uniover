using AwesomeAssertions;
using UniOver.BuildingBlocks.AgentProtocol.Generated;
using UniOver.Modules.Tv.Adapters;

namespace UniOver.Modules.Tv.Tests.Messages;

public class TvMessagesTests
{
    [Fact]
    public void Key_BuildsTheV2BodyWithTheContractName()
    {
        var message = TvMessages.Key(TvKeyV3BodyKey.VolumeUp);

        message.Type.Should().Be("tv.key.v2");
        message.Body.GetRawText().Should().Be("{\"key\":\"VOLUME_UP\"}");
    }

    [Fact]
    public void PowerOff_BuildsTheSafeTurnOffMessageWithAnEmptyBody()
    {
        var message = TvMessages.PowerOff();

        message.Type.Should().Be("tv.power.off.v1");
        message.Body.GetRawText().Should().Be("{}");
    }

    [Fact]
    public void Key_OutsideTheV2List_GoesInTheV3Message()
    {
        var message = TvMessages.Key(TvKeyV3BodyKey.Guide, TvKeyV2BodyDirection.Short);

        message.Type.Should().Be("tv.key.v3");
        message.Body.GetRawText().Should().Be("{\"direction\":\"SHORT\",\"key\":\"GUIDE\"}");
    }

    [Fact]
    public void Key_WithADirection_CarriesIt()
    {
        var message = TvMessages.Key(TvKeyV3BodyKey.Right, TvKeyV2BodyDirection.StartLong);

        message.Body.GetRawText().Should().Be("{\"direction\":\"START_LONG\",\"key\":\"RIGHT\"}");
    }

    [Theory]
    [InlineData("NUM_0", TvKeyV3BodyKey.Num0)]
    [InlineData("NUM_9", TvKeyV3BodyKey.Num9)]
    [InlineData("PLAY_PAUSE", TvKeyV3BodyKey.PlayPause)]
    [InlineData("MEDIA_NEXT", TvKeyV3BodyKey.MediaNext)]
    [InlineData("CHANNEL_DOWN", TvKeyV3BodyKey.ChannelDown)]
    [InlineData("OK", TvKeyV3BodyKey.Ok)]
    [InlineData("GUIDE", TvKeyV3BodyKey.Guide)]
    [InlineData("E_MANUAL", TvKeyV3BodyKey.EManual)]
    public void Keys_MapsTheContractNameToTheGeneratedEnum(string wire, TvKeyV3BodyKey expected)
    {
        TvMessages.Keys.Should().ContainKey(wire).WhoseValue.Should().Be(expected);
    }

    [Fact]
    public void Keys_CoversEveryKeyOfTheContract_AndNothingElse()
    {
        TvMessages.Keys.Should().HaveCount(Enum.GetValues<TvKeyV3BodyKey>().Length);
        TvMessages.Keys.Values.Should().BeEquivalentTo(Enum.GetValues<TvKeyV3BodyKey>());
        TvMessages.Keys.Keys.Should().NotContain("volume_up", "o nome é exatamente o do contrato");
    }

    [Fact]
    public void Directions_MapTheThreeContractValues()
    {
        TvMessages.Directions.Keys.Should().BeEquivalentTo(["SHORT", "START_LONG", "END_LONG"]);
    }

    [Fact]
    public void Text_BuildsTheBodyWithTheExactText()
    {
        var message = TvMessages.Text("olá \"mundo\"");

        message.Type.Should().Be("tv.text.v1");
        message.Body.GetProperty("text").GetString().Should().Be("olá \"mundo\"");
    }

    [Fact]
    public void LaunchPackage_TargetsAPackage()
    {
        var message = TvMessages.LaunchPackage("com.exemplo.app");

        message.Type.Should().Be("tv.app.launch.v1");
        message.Body.GetRawText().Should().Be("{\"target\":{\"kind\":\"package\",\"value\":\"com.exemplo.app\"}}");
    }

    [Fact]
    public void WakeAndRefresh_HaveAnEmptyBody()
    {
        TvMessages.Wake().Type.Should().Be("tv.wake.v1");
        TvMessages.Wake().Body.GetRawText().Should().Be("{}");
        TvMessages.AppsRefresh().Type.Should().Be("tv.apps.refresh.v1");
        TvMessages.AppsRefresh().Body.GetRawText().Should().Be("{}");
    }
}
