using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Encodings.Web;
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
        if (!Available) return false;
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

public sealed class PasswordRecoveryEmailOptions
{
    public bool Enabled { get; set; }
    public string? ApiKey { get; set; }
    public string? From { get; set; }
    public string? AppBaseUrl { get; set; }

    public bool IsValid() => !Enabled ||
        !string.IsNullOrWhiteSpace(ApiKey) && !string.IsNullOrWhiteSpace(From) &&
        Uri.TryCreate(AppBaseUrl, UriKind.Absolute, out var uri) && uri.Scheme == Uri.UriSchemeHttps &&
        uri.Query.Length == 0 && uri.Fragment.Length == 0;
}
