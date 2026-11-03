using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Options;
using UniOver.Modules.Identity.Security;

namespace UniOver.Modules.Identity.Tests.Security;

public sealed class AccountRecoverySecretsTests
{
    [Fact]
    public void TotpMatchesRfcVectorAndRejectsReuse()
    {
        var secret = Encoding.ASCII.GetBytes("12345678901234567890");
        var now = DateTimeOffset.FromUnixTimeSeconds(59);
        Assert.Equal("287082", TotpCodes.AtStep(secret, 1));
        Assert.Equal(1, TotpCodes.Match(secret, "287082", now));
        Assert.Null(TotpCodes.Match(secret, "287082", now, lastAcceptedStep: 1));
        Assert.Null(TotpCodes.Match(secret, "287O82", now));
    }

    [Fact]
    public void TotpProvisioningUsesAccountLabelAndSecret()
    {
        var secret = TotpCodes.NewSecret();
        var encoded = TotpCodes.ToBase32(secret);
        Assert.Equal(32, encoded.Length);
        var uri = TotpCodes.ProvisioningUri("owner@example.test", secret);
        Assert.Contains("secret=" + encoded, uri, StringComparison.Ordinal);
        Assert.Contains("UniOver%3Aowner%40example.test", uri, StringComparison.Ordinal);
        Assert.Contains("digits=6&period=30", uri, StringComparison.Ordinal);
    }

    [Fact]
    public void EncryptedTotpSecretBelongsOnlyToItsAccount()
    {
        var protector = new TotpSecretProtector(RandomNumberGenerator.GetBytes(32));
        var owner = Guid.NewGuid();
        var secret = TotpCodes.NewSecret();
        var encrypted = protector.Protect(owner, secret);
        Assert.NotEqual(secret, encrypted);
        Assert.Equal(secret, protector.Unprotect(owner, encrypted));
        Assert.ThrowsAny<CryptographicException>(() => protector.Unprotect(Guid.NewGuid(), encrypted));
        encrypted[^1] ^= 1;
        Assert.ThrowsAny<CryptographicException>(() => protector.Unprotect(owner, encrypted));
    }

    [Fact]
    public void RecoveryCodeIsRandomHashedAndStrictlyParsed()
    {
        var first = RecoveryCodes.Generate();
        var second = RecoveryCodes.Generate();
        Assert.Equal(32, first.Code.Length);
        Assert.NotEqual(first.Code, second.Code);
        Assert.Equal(first.Hash, RecoveryCodes.Hash(first.Code));
        Assert.Null(RecoveryCodes.Hash(first.Code + "x"));
        Assert.NotEqual(first.Hash, RecoveryCodes.Hash("00000000000000000000000000000000"));
    }

    [Fact]
    public async Task EmailDeliveryStaysOffWithoutExplicitConfiguration()
    {
        var sender = new ResendRecoveryEmailSender(new HttpClient(), Options.Create(new PasswordRecoveryEmailOptions()));
        Assert.False(sender.Available);
        Assert.False(await sender.TrySendAsync("owner@example.test", "token", CancellationToken.None));
        Assert.False(new PasswordRecoveryEmailOptions { Enabled = true }.IsValid());
        Assert.True(new PasswordRecoveryEmailOptions { Enabled = false }.IsValid());
        Assert.True(new PasswordRecoveryEmailOptions
        {
            Enabled = true, Provider = "Resend", ApiKey = "resend-key",
            From = "UniOver <conta@example.test>", AppBaseUrl = "https://uniover.onrender.com",
        }.IsValid());
    }

    [Fact]
    public async Task GmailSendsRecoveryLinkThroughHttpsWithoutExposingTheRefreshToken()
    {
        var requests = new List<(string Url, string? Authorization, string Body)>();
        using var http = new HttpClient(new StubHandler(async request =>
        {
            var body = await request.Content!.ReadAsStringAsync();
            requests.Add((request.RequestUri!.ToString(), request.Headers.Authorization?.ToString(), body));
            return request.RequestUri.Host == "oauth2.googleapis.com"
                ? new HttpResponseMessage(System.Net.HttpStatusCode.OK)
                { Content = new StringContent("{\"access_token\":\"short-lived-token\"}") }
                : new HttpResponseMessage(System.Net.HttpStatusCode.OK);
        }));
        var settings = new PasswordRecoveryEmailOptions
        {
            Enabled = true,
            Provider = "Gmail",
            From = "uniover@gmail.com",
            AppBaseUrl = "https://uniover.onrender.com",
            GmailClientId = "client-id",
            GmailClientSecret = "client-secret",
            GmailRefreshToken = "long-lived-token",
        };
        Assert.True(settings.IsValid());
        var sender = new GmailRecoveryEmailSender(http, Options.Create(settings));

        Assert.True(await sender.TrySendAsync("owner@example.test", "reset-token", CancellationToken.None));
        Assert.Equal(2, requests.Count);
        Assert.Equal("https://oauth2.googleapis.com/token", requests[0].Url);
        Assert.Contains("refresh_token=long-lived-token", requests[0].Body, StringComparison.Ordinal);
        Assert.Equal("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", requests[1].Url);
        Assert.Equal("Bearer short-lived-token", requests[1].Authorization);
        Assert.DoesNotContain("long-lived-token", requests[1].Body, StringComparison.Ordinal);
        using var json = JsonDocument.Parse(requests[1].Body);
        var raw = json.RootElement.GetProperty("raw").GetString()!;
        var mime = Encoding.UTF8.GetString(Convert.FromBase64String(raw.Replace('-', '+').Replace('_', '/') + new string('=', (4 - raw.Length % 4) % 4)));
        Assert.Contains("To: owner@example.test", mime, StringComparison.Ordinal);
        Assert.Contains("From: uniover@gmail.com", mime, StringComparison.Ordinal);
        var encodedHtml = mime.Split("\r\n\r\n", 2)[1].Trim();
        var html = Encoding.UTF8.GetString(Convert.FromBase64String(encodedHtml));
        Assert.Contains("https://uniover.onrender.com/redefinir-senha#token=reset-token", html, StringComparison.Ordinal);
    }

    [Fact]
    public async Task GmailDoesNotSendWhenAuthorizationFails()
    {
        var calls = 0;
        using var http = new HttpClient(new StubHandler(_ =>
        {
            calls++;
            return Task.FromResult(new HttpResponseMessage(System.Net.HttpStatusCode.Unauthorized));
        }));
        var settings = new PasswordRecoveryEmailOptions
        {
            Enabled = true, Provider = "Gmail", From = "uniover@gmail.com",
            AppBaseUrl = "https://uniover.onrender.com", GmailClientId = "id",
            GmailClientSecret = "secret", GmailRefreshToken = "refresh",
        };
        Assert.False(await new GmailRecoveryEmailSender(http, Options.Create(settings)).TrySendAsync(
            "owner@example.test", "reset-token", CancellationToken.None));
        Assert.Equal(1, calls);
        Assert.False(new PasswordRecoveryEmailOptions { Enabled = true, Provider = "Gmail", From = "bad\r\nBcc: x", AppBaseUrl = settings.AppBaseUrl }.IsValid());
        Assert.False(await new GmailRecoveryEmailSender(http, Options.Create(settings)).TrySendAsync(
            "owner@example.test\r\nBcc: other@example.test", "reset-token", CancellationToken.None));
        Assert.Equal(1, calls);
    }

    private sealed class StubHandler(Func<HttpRequestMessage, Task<HttpResponseMessage>> send) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken) => send(request);
    }
}
