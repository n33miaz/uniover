using UniOver.BuildingBlocks.Messaging;
using UniOver.BuildingBlocks.Web;
using UniOver.Modules.Devices;
using UniOver.Modules.Devices.Features.Agents;
using UniOver.Modules.Devices.Transport.WebSocket;
using UniOver.Modules.Identity;
using UniOver.Modules.Tv;

var builder = WebApplication.CreateBuilder(args);

// O Render injeta PORT; localmente vale a configuração padrão do Kestrel.
var port = Environment.GetEnvironmentVariable("PORT");
if (!string.IsNullOrWhiteSpace(port))
{
    builder.WebHost.UseUrls($"http://0.0.0.0:{port}");
}

builder.Services.AddUniOverProblemDetails();
builder.Services.AddUniOverRateLimiting(builder.Configuration);
builder.Services.AddUniOverSecurityHeaders(builder.Configuration);
builder.Services.AddUniOverPwa(builder.Configuration);
builder.Services.AddHealthChecks();
builder.Services.AddOpenApi();

// [composição: eventos]
builder.Services.AddUniOverMessaging(builder.Configuration);
// [composição: autenticação]
builder.Services.AddUniOverAuthentication(builder.Configuration);
// [composição: passkeys]
builder.Services.AddIdentityPasskeys(builder.Configuration);

// O Host só compõe: cada módulo é chamado explicitamente, sem descoberta por reflexão.
builder.Services.AddTvModule(builder.Configuration);
// [composição: tv]
builder.Services.AddIdentityModule(builder.Configuration);
builder.Services.AddDevicesModule(builder.Configuration);
// [composição: devices-transport]
builder.Services.AddDevicesTransport(builder.Configuration);
builder.Services.AddDevicesWebSocketTransport();

var app = builder.Build();

// Ordem importa: IP real primeiro (o limite por IP depende dele), cabeçalhos e erros antes de qualquer resposta.
app.UseUniOverForwardedHeaders();
app.UseUniOverSecurityHeaders();
app.UseUniOverProblemDetails();
app.UseUniOverStaticFiles();
// [pipeline: autenticação] UseAuthentication e UseAuthorization entram aqui.
app.UseUniOverAuthentication();

// Depois da autenticação de propósito: a política "commands" separa o balde por usuário (claim sub), que só existe
// quando o JWT já foi lido. Rotas anônimas (login, refresh) não têm sub e continuam por IP.
app.UseUniOverRateLimiting();

if (app.Environment.IsDevelopment())
{
    app.MapOpenApi().AllowAnonymous();
}

// /health/live e /openapi nunca tocam no banco: o monitor externo os chama a cada 5 min e uma consulta
// manteria o compute do Neon acordado o mês inteiro.
app.MapHealthChecks("/health/live").AllowAnonymous();
app.MapTvEndpoints();
app.MapIdentityEndpoints();
app.MapDevicesEndpoints();
app.MapDevicesTransport();
app.MapDevicesWebSocketTransport();
app.MapUniOverPwa();

app.Run();

// Torna o Program visível para o WebApplicationFactory nos testes de integração.
public partial class Program;
