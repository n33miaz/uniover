using System.Text.Json;
using AwesomeAssertions;
using UniOver.BuildingBlocks.AgentProtocol.Generated;
using UniOver.Modules.Tv.Adapters;
using UniOver.Modules.Tv.Domain;
using UniOver.Modules.Tv.Features.TvLivre;
using UniOver.Modules.Tv.Tests.Validation;

namespace UniOver.Modules.Tv.Tests.Messages;

public class TvLivreMessagesTests
{
    private static readonly Guid Request = Guid.Parse("018f0000-0000-7000-8000-000000000001");
    private static readonly Guid Photo = Guid.Parse("018f0000-0000-7000-8000-000000000002");

    /// <summary>Os nomes do campo <c>action</c> no contrato, lidos do próprio esquema (a fonte da verdade).</summary>
    private static string[] ContractActions()
    {
        using var document = JsonDocument.Parse(File.ReadAllText(
            LivreConfigValidatorTests.ContractPath("agent", "messages", "tv.livre.v1.schema.json")));
        return [.. document.RootElement.GetProperty("properties").GetProperty("body").GetProperty("properties")
            .GetProperty("action").GetProperty("enum").EnumerateArray().Select(a => a.GetString()!)];
    }

    private static string Kebab(string pascal) =>
        string.Concat(pascal.Select((c, i) => i > 0 && char.IsUpper(c) ? "-" + char.ToLowerInvariant(c) : char.ToLowerInvariant(c).ToString()));

    [Fact]
    public void EveryAction_HasItsContractName_AndNoneIsMissing()
    {
        var sent = Enum.GetValues<TvLivreAction>()
            .Select(action => TvMessages.TvLivre(Request, action).Body.GetProperty("action").GetString()!)
            .ToArray();

        sent.Should().BeEquivalentTo(ContractActions(), "cada passo do contrato tem o seu valor, com o nome exato do esquema");
        Enum.GetValues<TvLivreAction>().Select(a => Kebab(a.ToString())).Should().BeEquivalentTo(sent);
    }

    [Fact]
    public void Status_CarriesOnlyTheRequestIdAndTheAction()
    {
        var message = TvMessages.TvLivre(Request, TvLivreAction.Status);

        message.Type.Should().Be("tv.livre.v1");
        message.Body.GetRawText().Should().Be($"{{\"action\":\"status\",\"requestId\":\"{Request}\"}}");
    }

    [Fact]
    public void Apply_CarriesRevisionConfigAndPhotoId()
    {
        var message = TvMessages.TvLivre(
            Request, TvLivreAction.Apply, revision: 3, configJson: "{\"clock\":{}}", photoId: Photo);

        var body = message.Body;
        body.GetProperty("action").GetString().Should().Be("apply");
        body.GetProperty("revision").GetInt32().Should().Be(3);
        body.GetProperty("configJson").GetString().Should().Be("{\"clock\":{}}");
        body.GetProperty("photoId").GetGuid().Should().Be(Photo);
        body.TryGetProperty("disableFactory", out _).Should().BeFalse();
    }

    [Fact]
    public void Apply_WithoutAPhoto_OmitsThePhotoId() =>
        TvMessages.TvLivre(Request, TvLivreAction.Apply, revision: 1, configJson: "{}")
            .Body.TryGetProperty("photoId", out _).Should().BeFalse();

    [Fact]
    public void SetHome_CarriesTheDisableFactoryChoice()
    {
        TvMessages.TvLivre(Request, TvLivreAction.SetHome, disableFactory: true).Body
            .GetProperty("disableFactory").GetBoolean().Should().BeTrue();
        TvMessages.TvLivre(Request, TvLivreAction.SetHome, disableFactory: false).Body
            .GetProperty("disableFactory").GetBoolean().Should().BeFalse();
    }

    [Fact]
    public void Restore_CarriesTheUninstallChoice() =>
        TvMessages.TvLivre(Request, TvLivreAction.Restore, uninstall: false).Body
            .GetProperty("uninstall").GetBoolean().Should().BeFalse();

    [Fact]
    public void SetApps_CarriesBothPackageLists()
    {
        var body = TvMessages.TvLivre(
            Request, TvLivreAction.SetApps, disable: ["com.a.b"], enable: ["com.c.d", "com.e.f"]).Body;

        body.GetProperty("disable").EnumerateArray().Select(p => p.GetString()).Should().Equal("com.a.b");
        body.GetProperty("enable").EnumerateArray().Select(p => p.GetString()).Should().Equal("com.c.d", "com.e.f");
    }

    [Fact]
    public void ThePhotoChunk_CarriesItsPlaceInTheWholeAndTheBase64OfItsBytes()
    {
        byte[] data = [0xFF, 0xD8, 0xFF, 0xE0, 1, 2, 3];

        var message = TvMessages.TvLivrePhotoChunk(Photo, 2, 5, new string('a', 64), data);

        message.Type.Should().Be("tv.livre.photo.v1");
        message.Body.GetProperty("photoId").GetGuid().Should().Be(Photo);
        message.Body.GetProperty("index").GetInt32().Should().Be(2);
        message.Body.GetProperty("total").GetInt32().Should().Be(5);
        message.Body.GetProperty("sha256").GetString().Should().Be(new string('a', 64));
        Convert.FromBase64String(message.Body.GetProperty("data").GetString()!).Should().Equal(data);
    }

    [Fact]
    public void AFullChunk_FitsTheContractLimitOf40000Characters()
    {
        var data = new byte[LivrePhoto.ChunkBytes];

        var message = TvMessages.TvLivrePhotoChunk(Photo, 0, 1, new string('0', 64), data);

        message.Body.GetProperty("data").GetString()!.Length.Should().Be(40000);
        message.Body.GetRawText().Length.Should().BeLessThan(64 * 1024 - 2048, "o transporte recusa mais de 64 KB com o envelope");
    }

    [Fact]
    public void TheLivreTypes_AreTheOnesInTheContract()
    {
        AgentMessageTypes.TvLivreV1.Should().Be("tv.livre.v1");
        AgentMessageTypes.TvLivrePhotoV1.Should().Be("tv.livre.photo.v1");
        AgentMessageTypes.TvLivreStateV1.Should().Be("tv.livre.state.v1");
    }
}
