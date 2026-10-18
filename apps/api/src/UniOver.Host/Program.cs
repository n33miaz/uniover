using UniOver.BuildingBlocks.Messaging;
using UniOver.BuildingBlocks.Web;
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

// O Host só compõe: cada módulo é chamado explicitamente, sem descoberta por reflexão.
builder.Services.AddTvModule(builder.Configuration);
builder.Services.AddIdentityModule(builder.Configuration);

var app = builder.Build();

// Ordem importa: IP real primeiro (o limite depende dele), cabeçalhos e erros antes de qualquer resposta.
app.UseUniOverForwardedHeaders();
app.UseUniOverSecurityHeaders();
app.UseUniOverProblemDetails();
app.UseUniOverStaticFiles();
app.UseUniOverRateLimiting();
// [pipeline: autenticação] UseAuthentication e UseAuthorization entram aqui.
app.UseUniOverAuthentication();

if (app.Environment.IsDevelopment())
{
    app.MapOpenApi().AllowAnonymous();
}

// /health/live e /openapi nunca tocam no banco: o monitor externo os chama a cada 5 min e uma consulta
// manteria o compute do Neon acordado o mês inteiro.
app.MapHealthChecks("/health/live").AllowAnonymous();
app.MapTvEndpoints();
app.MapIdentityEndpoints();
app.MapUniOverPwa();

app.Run();

// Torna o Program visível para o WebApplicationFactory nos testes de integração.
public partial class Program;
