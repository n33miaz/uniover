using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Net.Mail;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using Microsoft.Extensions.Options;

namespace UniOver.Modules.Identity.Security;

/// <summary>Entrega do link de recuperação. O segredo nunca vai para logs, auditoria ou resposta HTTP.</summary>
internal interface IRecoveryEmailSender
{
    bool Available { get; }
    Task<bool> TrySendAsync(string email, string token, CancellationToken cancellationToken);
}

/// <summary>Envio por API HTTP; o serviço permanece desativado até chave, remetente e domínio verificados.</summary>
internal sealed class ResendRecoveryEmailSender(HttpClient http, IOptions<PasswordRecoveryEmailOptions> options) : IRecoveryEmailSender
{
    private readonly PasswordRecoveryEmailOptions settings = options.Value;

    public bool Available => settings.Enabled;

    public async Task<bool> TrySendAsync(string email, string token, CancellationToken cancellationToken)
    {
        if (!Available || !PasswordRecoveryEmailOptions.ValidAddress(email)) return false;
        var url = settings.AppBaseUrl!.TrimEnd('/') + "/redefinir-senha#token=" + Uri.EscapeDataString(token);
        var safeUrl = HtmlEncoder.Default.Encode(url);
        using var request = new HttpRequestMessage(HttpMethod.Post, "https://api.resend.com/emails");
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", settings.ApiKey);
        request.Content = JsonContent.Create(new
        {
            from = settings.From,
            to = new[] { email },
            subject = "Redefinir a senha do UniOver",
            html = $"<p>Recebemos um pedido de nova senha. O link vale por 20 minutos.</p><p><a href=\"{safeUrl}\">Escolher outra senha</a></p><p>Se não foi você, ignore este e-mail.</p>",
        });
        try
        {
            using var response = await http.SendAsync(request, cancellationToken);
            return response.IsSuccessStatusCode;
        }
        catch (HttpRequestException)
        {
            return false;
        }
        catch (TaskCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            return false;
        }
    }
}

/// <summary>Envio direto pela Gmail API via HTTPS, sem SMTP nem Apps Script.</summary>
internal sealed class GmailRecoveryEmailSender(HttpClient http, IOptions<PasswordRecoveryEmailOptions> options) : IRecoveryEmailSender
{
    private readonly PasswordRecoveryEmailOptions settings = options.Value;

    public bool Available => settings.Enabled;

    public async Task<bool> TrySendAsync(string email, string token, CancellationToken cancellationToken)
    {
        if (!Available || !PasswordRecoveryEmailOptions.ValidAddress(email)) return false;

        try
        {
            using var tokenRequest = new HttpRequestMessage(HttpMethod.Post, "https://oauth2.googleapis.com/token")
            {
                Content = new FormUrlEncodedContent(new Dictionary<string, string>
                {
                    ["client_id"] = settings.GmailClientId!,
                    ["client_secret"] = settings.GmailClientSecret!,
                    ["refresh_token"] = settings.GmailRefreshToken!,
                    ["grant_type"] = "refresh_token",
                }),
            };
            using var tokenResponse = await http.SendAsync(tokenRequest, cancellationToken);
            if (!tokenResponse.IsSuccessStatusCode) return false;
            using var tokenJson = await JsonDocument.ParseAsync(
                await tokenResponse.Content.ReadAsStreamAsync(cancellationToken), cancellationToken: cancellationToken);
            if (!tokenJson.RootElement.TryGetProperty("access_token", out var accessToken) ||
                accessToken.ValueKind != JsonValueKind.String || string.IsNullOrWhiteSpace(accessToken.GetString())) return false;

            var url = settings.AppBaseUrl!.TrimEnd('/') + "/redefinir-senha#token=" + Uri.EscapeDataString(token);
            var html = $"<p>Recebemos um pedido de nova senha. O link vale por 20 minutos.</p><p><a href=\"{HtmlEncoder.Default.Encode(url)}\">Escolher outra senha</a></p><p>Se não foi você, ignore este e-mail.</p>";
            var mime = $"From: {settings.From}\r\nTo: {email}\r\nSubject: Redefinir a senha do UniOver\r\nMIME-Version: 1.0\r\nContent-Type: text/html; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n{Convert.ToBase64String(Encoding.UTF8.GetBytes(html))}\r\n";
            var raw = Convert.ToBase64String(Encoding.UTF8.GetBytes(mime)).TrimEnd('=').Replace('+', '-').Replace('/', '_');
            using var sendRequest = new HttpRequestMessage(HttpMethod.Post, "https://gmail.googleapis.com/gmail/v1/users/me/messages/send");
            sendRequest.Headers.Authorization = new AuthenticationHeaderValue("Bearer", accessToken.GetString());
            sendRequest.Content = JsonContent.Create(new { raw });
            using var sendResponse = await http.SendAsync(sendRequest, cancellationToken);
            return sendResponse.IsSuccessStatusCode;
        }
        catch (HttpRequestException) { return false; }
        catch (TaskCanceledException) when (!cancellationToken.IsCancellationRequested) { return false; }
        catch (JsonException) { return false; }
    }
}

public sealed class PasswordRecoveryEmailOptions
{
    public bool Enabled { get; set; }
    public string Provider { get; set; } = "Resend";
    public string? ApiKey { get; set; }
    public string? From { get; set; }
    public string? AppBaseUrl { get; set; }
    public string? GmailClientId { get; set; }
    public string? GmailClientSecret { get; set; }
    public string? GmailRefreshToken { get; set; }

    public bool IsValid()
    {
        if (!Enabled) return true;
        if (!Uri.TryCreate(AppBaseUrl, UriKind.Absolute, out var uri) || uri.Scheme != Uri.UriSchemeHttps ||
            uri.Query.Length != 0 || uri.Fragment.Length != 0) return false;
        return Provider switch
        {
            "Resend" => !string.IsNullOrWhiteSpace(ApiKey) && !string.IsNullOrWhiteSpace(From) &&
                !From.Contains('\r') && !From.Contains('\n'),
            "Gmail" => ValidAddress(From) && !string.IsNullOrWhiteSpace(GmailClientId) &&
                !string.IsNullOrWhiteSpace(GmailClientSecret) && !string.IsNullOrWhiteSpace(GmailRefreshToken),
            _ => false,
        };
    }

    internal static bool ValidAddress(string? value) =>
        !string.IsNullOrWhiteSpace(value) && !value.Contains('\r') && !value.Contains('\n') &&
        MailAddress.TryCreate(value, out var address) && address.Address == value;
}
