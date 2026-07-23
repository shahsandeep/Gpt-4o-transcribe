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
builder.Services.AddHttpClient("azure-transcribe", client =>
{
    client.Timeout = TimeSpan.FromSeconds(120);
});
builder.Services.AddSingleton<TranslationService>();
builder.Services.AddSingleton<RestTranscriptionService>();

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

// --- REST transcription endpoint ---
// Independent of the WebSocket path: POST a complete audio file, get the whole
// transcript at once, optionally translated. Behavior-identical to the Python
// backend's POST /rest/transcribe.
app.MapPost("/rest/transcribe", async (HttpContext context) =>
{
    if (!context.Request.HasFormContentType)
    {
        return Results.Json(
            new { error = "expected multipart/form-data" },
            statusCode: StatusCodes.Status415UnsupportedMediaType);
    }

    var options = context.RequestServices.GetRequiredService<AzureOptions>();
    var transcription = context.RequestServices.GetRequiredService<RestTranscriptionService>();
    var translation = context.RequestServices.GetRequiredService<TranslationService>();
    var loggerFactory = context.RequestServices.GetRequiredService<ILoggerFactory>();
    var logger = loggerFactory.CreateLogger("RestTranscribe");

    var form = await context.Request.ReadFormAsync(context.RequestAborted);

    var file = form.Files["file"];
    if (file is null)
    {
        return Results.Json(
            new { error = "missing file" },
            statusCode: StatusCodes.Status400BadRequest);
    }

    var inputLanguage = form["inputLanguage"].ToString();
    var targetLanguage = form["targetLanguage"].ToString();
    var translateFlag = form["translate"].ToString();
    var translate = translateFlag.Trim().Equals("true", StringComparison.OrdinalIgnoreCase);

    byte[] audio;
    await using (var stream = file.OpenReadStream())
    using (var ms = new MemoryStream())
    {
        await stream.CopyToAsync(ms, context.RequestAborted);
        audio = ms.ToArray();
    }

    string transcript;
    long transcribeMs;
    try
    {
        (transcript, transcribeMs) = await transcription.TranscribeAsync(
            audio,
            string.IsNullOrEmpty(file.FileName) ? "audio.wav" : file.FileName,
            string.IsNullOrEmpty(file.ContentType) ? "application/octet-stream" : file.ContentType,
            inputLanguage,
            context.RequestAborted);
    }
    catch (TranscriptionException ex)
    {
        return Results.Json(new { error = ex.Message }, statusCode: StatusCodes.Status502BadGateway);
    }
    catch (Exception ex)
    {
        logger.LogError(ex, "REST transcription failed");
        return Results.Json(
            new { error = $"azure transcription failed: {ex.Message}" },
            statusCode: StatusCodes.Status502BadGateway);
    }

    // Ordered, null-preserving payload: `translation` is always present (null when
    // absent), but `translateError` is only added when a translation attempt fails.
    var result = new Dictionary<string, object?>
    {
        ["transcript"] = transcript,
        ["translation"] = null,
        ["transcribeMs"] = transcribeMs,
        ["translateMs"] = 0L,
    };

    if (translate && !string.IsNullOrEmpty(transcript))
    {
        var stopwatch = System.Diagnostics.Stopwatch.StartNew();
        try
        {
            result["translation"] = await translation.TranslateAsync(
                transcript, targetLanguage, context.RequestAborted);
            stopwatch.Stop();
            result["translateMs"] = stopwatch.ElapsedMilliseconds;
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "REST translation failed");
            result["translation"] = null;
            result["translateError"] = $"translation failed: {ex.Message}";
        }
    }

    return Results.Json(result);
});

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
