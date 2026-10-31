using Microsoft.AspNetCore.Diagnostics.HealthChecks;
using UniOver.BuildingBlocks.Messaging;
using UniOver.BuildingBlocks.Persistence;
using UniOver.BuildingBlocks.Web;
using UniOver.Modules.Devices;
using UniOver.Modules.Devices.Features.Agents;
using UniOver.Modules.Devices.Transport.WebSocket;
using UniOver.Modules.Identity;
using UniOver.Modules.Training;
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
builder.Services.AddUniOverRequestLimits(builder.Configuration);
builder.Services.AddUniOverSecurityHeaders(builder.Configuration);
builder.Services.AddUniOverPwa(builder.Configuration);
// A verificação do banco leva a etiqueta "ready": só /health/ready a executa (ver o mapeamento abaixo).
builder.Services.AddHealthChecks().AddUniOverDatabaseCheck();
builder.Services.AddOpenApi(options => options.AddIdempotencyHeader());

// [composição: eventos]
builder.Services.AddUniOverMessaging(builder.Configuration);
// [composição: autenticação]
builder.Services.AddUniOverAuthentication(builder.Configuration);
// [composição: passkeys]
builder.Services.AddIdentityPasskeys(builder.Configuration);

// O Host só compõe: cada módulo é chamado explicitamente, sem descoberta por reflexão.
builder.Services.AddTvModule(builder.Configuration);
// [composição: tv]
builder.Services.AddTrainingModule(builder.Configuration);
// [composição: training]
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
// Teto de corpo para toda rota (a rota de foto e a de importação declaram o próprio); antes da autenticação e de qualquer leitura.
app.UseUniOverRequestBodyLimit();
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
// manteria o compute do Neon acordado o mês inteiro. O predicado vazio é o que garante isso: sem ele a rota executaria
// toda verificação registrada, inclusive a do banco.
app.MapHealthChecks("/health/live", new HealthCheckOptions { Predicate = _ => false }).AllowAnonymous();

// /health/ready consulta o banco (SELECT 1, com o resultado guardado por 30 s) e devolve só o status, 200 ou 503. É para
// diagnóstico e para o primeiro toque depois de um tempo parado; NÃO é para monitor de 5 em 5 minutos (mantém o Neon
// acordado e estoura as horas de compute do plano gratuito). Por ser anônima e acordar o banco, tem limite por IP.
app.MapHealthChecks("/health/ready", new HealthCheckOptions { Predicate = check => check.Tags.Contains(HealthTags.Ready) })
    .AllowAnonymous()
    .RequireRateLimiting(RateLimitPolicies.HealthReady);
var productVersion = typeof(Program).Assembly.GetName().Version?.ToString(3) ?? "0.0.0";
app.MapDeploymentVersion(builder.Configuration, productVersion);
app.MapTvEndpoints();
app.MapTrainingEndpoints();
app.MapIdentityEndpoints();
app.MapDevicesEndpoints();
app.MapDevicesTransport();
app.MapDevicesWebSocketTransport();
app.MapUniOverPwa();

app.Run();

// Torna o Program visível para o WebApplicationFactory nos testes de integração.
public partial class Program;
