using TranscribeApi.Audio;
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
builder.Services.AddSingleton<AudioEnhancer>();

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
    var enhancer = context.RequestServices.GetRequiredService<AudioEnhancer>();
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
    var enhanceFlag = form["enhance"].ToString();
    var enhanceRequested = enhanceFlag.Trim().Equals("true", StringComparison.OrdinalIgnoreCase);

    byte[] audio;
    await using (var stream = file.OpenReadStream())
    using (var ms = new MemoryStream())
    {
        await stream.CopyToAsync(ms, context.RequestAborted);
        audio = ms.ToArray();
    }

    // Optional server-side ffmpeg enhancement before upload (graceful fallback).
    var enhanced = false;
    if (enhanceRequested)
    {
        (audio, enhanced) = await enhancer.EnhanceAsync(
            audio, options.AudioEnhanceFilters, context.RequestAborted);
    }

    IReadOnlyList<TranscriptTurn> turns;
    long transcribeMs;
    try
    {
        (turns, transcribeMs) = await transcription.TranscribeAsync(
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

    var transcript = RestTranscriptionService.JoinTurns(
        turns.Select(t => (t.Speaker, t.Text)));

    // One entry per speaker turn (speaker null for non-diarized audio).
    var translations = new string?[turns.Count];
    long translateMs = 0L;
    string? translateError = null;

    if (translate && !string.IsNullOrEmpty(transcript))
    {
        var stopwatch = System.Diagnostics.Stopwatch.StartNew();
        // Translate each turn separately so translations align per turn.
        var tasks = turns.Select(async t =>
        {
            try
            {
                return (Text: await translation.TranslateAsync(
                    t.Text, targetLanguage, context.RequestAborted), Error: (string?)null);
            }
            catch (Exception ex)
            {
                return (Text: (string?)null, Error: $"translation failed: {ex.Message}");
            }
        }).ToArray();

        var outcomes = await Task.WhenAll(tasks);
        stopwatch.Stop();
        translateMs = stopwatch.ElapsedMilliseconds;

        for (var i = 0; i < outcomes.Length; i++)
        {
            translations[i] = outcomes[i].Text;
            if (outcomes[i].Error is not null && translateError is null)
            {
                logger.LogError("REST turn translation failed: {Error}", outcomes[i].Error);
                translateError = outcomes[i].Error;
            }
        }
    }

    var segments = turns.Select((t, i) => new Dictionary<string, object?>
    {
        ["speaker"] = t.Speaker,
        ["text"] = t.Text,
        ["translation"] = translations[i],
    }).ToList();

    var translationJoined = translate
        ? RestTranscriptionService.JoinTurns(turns.Select((t, i) => (t.Speaker, translations[i] ?? "")))
        : null;

    // Ordered, null-preserving payload: `translation` is always present (null when
    // absent), but `translateError` is only added when a translation attempt fails.
    var result = new Dictionary<string, object?>
    {
        ["transcript"] = transcript,
        ["translation"] = string.IsNullOrEmpty(translationJoined) ? null : translationJoined,
        ["enhanced"] = enhanced,
        ["segments"] = segments,
        ["transcribeMs"] = transcribeMs,
        ["translateMs"] = translateMs,
    };
    if (translateError is not null)
    {
        result["translateError"] = translateError;
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
