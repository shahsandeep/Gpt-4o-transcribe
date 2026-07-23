using TranscribeApi.Config;
using TranscribeApi.Realtime;

var builder = WebApplication.CreateBuilder(args);

// --- Configuration (bound from environment) ---
// Load the shared repo-root .env when running outside Docker (real environment
// variables, e.g. from Docker's env_file or an exported shell, still take priority).
DotEnv.Load();
var azureOptions = AzureOptions.FromEnvironment();
builder.Services.AddSingleton(azureOptions);

// Listen on 0.0.0.0:<DOTNET_PORT> (default 8080).
builder.WebHost.UseUrls($"http://0.0.0.0:{azureOptions.Port}");

// --- Services ---
builder.Services.AddHttpClient("azure-chat", client =>
{
    client.Timeout = TimeSpan.FromSeconds(30);
});
builder.Services.AddSingleton<TranslationService>();

// Permissive CORS so the frontend can connect from any origin.
builder.Services.AddCors(options =>
{
    options.AddDefaultPolicy(policy =>
        policy.AllowAnyOrigin().AllowAnyMethod().AllowAnyHeader());
});

var app = builder.Build();

app.UseCors();
app.UseWebSockets();

// --- Health check ---
app.MapGet("/health", () => Results.Json(new { status = "ok" }));

// --- WebSocket transcription endpoint ---
app.Map("/ws/transcribe", async (HttpContext context) =>
{
    if (!context.WebSockets.IsWebSocketRequest)
    {
        context.Response.StatusCode = StatusCodes.Status400BadRequest;
        await context.Response.WriteAsync("Expected a WebSocket request");
        return;
    }

    var loggerFactory = context.RequestServices.GetRequiredService<ILoggerFactory>();
    var logger = loggerFactory.CreateLogger("TranscriptionSession");
    var options = context.RequestServices.GetRequiredService<AzureOptions>();
    var translation = context.RequestServices.GetRequiredService<TranslationService>();

    using var socket = await context.WebSockets.AcceptWebSocketAsync();

    var session = new TranscriptionSession(socket, options, translation, logger);
    try
    {
        await session.RunAsync(context.RequestAborted);
    }
    catch (Exception ex)
    {
        // Never let a session crash the server.
        logger.LogError(ex, "Unhandled error in transcription session");
    }
});

app.Run();
