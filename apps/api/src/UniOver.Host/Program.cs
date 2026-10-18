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
builder.Services.AddHealthChecks();
builder.Services.AddOpenApi();

// O Host só compõe: cada módulo é chamado explicitamente, sem descoberta por reflexão.
builder.Services.AddTvModule(builder.Configuration);
builder.Services.AddIdentityModule(builder.Configuration);

var app = builder.Build();

if (app.Environment.IsDevelopment())
{
    app.MapOpenApi();
}

app.UseDefaultFiles();
app.UseStaticFiles();

app.MapHealthChecks("/health/live").AllowAnonymous();
app.MapTvEndpoints();
app.MapIdentityEndpoints();

// Rotas desconhecidas em /api e /health devem dar 404; só o resto cai no index.html do PWA.
app.MapFallback("/api/{**path}", () => Results.NotFound());
app.MapFallback("/health/{**path}", () => Results.NotFound());
app.MapFallbackToFile("index.html");

app.Run();

// Torna o Program visível para o WebApplicationFactory nos testes de integração.
public partial class Program;
