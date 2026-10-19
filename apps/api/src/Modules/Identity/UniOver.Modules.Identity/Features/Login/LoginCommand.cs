using System.Text.Json.Serialization;
using UniOver.Modules.Identity.Security;

namespace UniOver.Modules.Identity.Features.Login;

internal sealed record LoginRequest(string? Email, string? Password);

internal sealed record LoginCommand(string Email, string Password, ClientInfo Client);

internal sealed record LoginResponse(string AccessToken, [property: JsonNumberHandling(JsonNumberHandling.Strict)] int ExpiresIn);
