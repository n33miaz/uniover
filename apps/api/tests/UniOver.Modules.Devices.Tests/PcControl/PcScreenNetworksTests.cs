using AwesomeAssertions;
using Microsoft.Extensions.Configuration;
using UniOver.Modules.Devices.Features.PcControl;

namespace UniOver.Modules.Devices.Tests.PcControl;

/// <summary>A faixa de VPN da tela do PC: sem configuração nada muda; com ela, só a faixa e as redes internas passam.</summary>
public sealed class PcScreenNetworksTests
{
    private static PcScreenNetworks With(params string[] entries) =>
        new(new ConfigurationBuilder()
            .AddInMemoryCollection(entries.Select((entry, i) => KeyValuePair.Create<string, string?>($"{PcScreenNetworks.ConfigurationKey}:{i}", entry)))
            .Build());

    [Theory]
    [InlineData("203.0.113.9")]
    [InlineData("100.64.0.1")]
    [InlineData("192.168.0.10")]
    [InlineData("::1")]
    [InlineData("not-an-ip")]
    [InlineData(null)]
    public void WithoutConfiguration_EveryAddressIsAllowed_AsAlways(string? ip)
    {
        var networks = With();

        networks.Configured.Should().BeFalse();
        networks.Allows(ip).Should().BeTrue();
    }

    [Fact]
    public void BlankEntriesCountAsNotConfigured()
    {
        var networks = With("", "  ");

        networks.Configured.Should().BeFalse();
        networks.Allows("203.0.113.9").Should().BeTrue();
    }

    [Theory]
    [InlineData("100.64.0.1", true)]
    [InlineData("100.127.255.254", true)]
    [InlineData("100.128.0.1", false)]
    [InlineData("100.63.255.255", false)]
    [InlineData("203.0.113.9", false)]
    [InlineData("::ffff:100.100.1.1", true)]
    [InlineData("192.168.1.20", true)]
    [InlineData("127.0.0.1", true)]
    [InlineData("not-an-ip", false)]
    [InlineData(null, false)]
    public void WithARange_OnlyItAndTheInternalNetworksPass(string? ip, bool expected) =>
        With("100.64.0.0/10").Allows(ip).Should().Be(expected);

    [Fact]
    public void AnInvalidEntryIsIgnoredAndNeverOpensMoreThanConfigured()
    {
        var networks = With("garbage", "100.64.0.0/10");

        networks.Configured.Should().BeTrue();
        networks.Allows("100.64.0.1").Should().BeTrue();
        networks.Allows("203.0.113.9").Should().BeFalse();
    }

    [Fact]
    public void OnlyInvalidEntries_StillCountAsConfigured_AndAllowOnlyInternalNetworks()
    {
        var networks = With("garbage");

        networks.Configured.Should().BeTrue();
        networks.Allows("203.0.113.9").Should().BeFalse();
        networks.Allows("10.0.0.5").Should().BeTrue();
    }
}
