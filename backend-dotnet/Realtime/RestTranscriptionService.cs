using System.Diagnostics;
using System.Net.Http.Headers;
using System.Text.Json;
using TranscribeApi.Config;

namespace TranscribeApi.Realtime;

/// <summary>
/// Raised when Azure returns a non-2xx response for a REST transcription request.
/// Carries the HTTP status and a short reason so the endpoint can surface it.
/// </summary>
public sealed class TranscriptionException : Exception
{
    public int Status { get; }

    public TranscriptionException(int status, string reason)
        : base($"azure transcription failed: {status} {reason}")
    {
        Status = status;
    }
}

/// <summary>
/// Transcribes complete audio files via the Azure REST
/// <c>/audio/transcriptions</c> endpoint.
///
/// The realtime WebSocket path streams PCM up and transcripts down. This service
/// is the independent REST path: a single POST of a complete audio file to Azure,
/// returning the whole transcript at once. Behavior-identical to the Python
/// backend's <c>rest_transcribe.transcribe_audio</c>.
/// </summary>
public sealed class RestTranscriptionService
{
    private readonly IHttpClientFactory _httpClientFactory;
    private readonly AzureOptions _options;
    private readonly ILogger<RestTranscriptionService> _logger;

    public RestTranscriptionService(
        IHttpClientFactory httpClientFactory,
        AzureOptions options,
        ILogger<RestTranscriptionService> logger)
    {
        _httpClientFactory = httpClientFactory;
        _options = options;
        _logger = logger;
    }

    /// <summary>
    /// POST <paramref name="audio"/> to Azure's REST transcription endpoint.
    ///
    /// Sends multipart/form-data with a <c>file</c> part, <c>response_format=json</c>,
    /// and (only when <paramref name="inputLanguage"/> is set and not "auto") a
    /// <c>language</c> part. Returns <c>(text, elapsedMs)</c> where <c>elapsedMs</c>
    /// is the wall-clock duration of the Azure call. Throws
    /// <see cref="TranscriptionException"/> on any non-2xx response.
    /// </summary>
    public async Task<(string Text, long Ms)> TranscribeAsync(
        byte[] audio,
        string fileName,
        string contentType,
        string? inputLanguage,
        CancellationToken ct)
    {
        using var form = new MultipartFormDataContent();

        var fileContent = new ByteArrayContent(audio);
        fileContent.Headers.ContentType = MediaTypeHeaderValue.Parse(contentType);
        form.Add(fileContent, "file", fileName);

        form.Add(new StringContent("json"), "response_format");

        if (!string.IsNullOrWhiteSpace(inputLanguage) &&
            !inputLanguage.Trim().Equals("auto", StringComparison.OrdinalIgnoreCase))
        {
            form.Add(new StringContent(inputLanguage.Trim()), "language");
        }

        using var request = new HttpRequestMessage(HttpMethod.Post, _options.TranscriptionRestUrl)
        {
            Content = form,
        };
        request.Headers.TryAddWithoutValidation("api-key", _options.ApiKey);
        request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));

        var client = _httpClientFactory.CreateClient("azure-transcribe");

        var stopwatch = Stopwatch.StartNew();
        using var response = await client.SendAsync(request, ct).ConfigureAwait(false);
        var responseBody = await response.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
        stopwatch.Stop();
        var elapsedMs = stopwatch.ElapsedMilliseconds;

        if (!response.IsSuccessStatusCode)
        {
            var reason = (response.ReasonPhrase ?? "").Trim();
            var body = (responseBody ?? "").Trim();
            if (body.Length > 0)
            {
                // Keep it short so it fits an error line.
                reason = (reason + " " + body).Trim();
                if (reason.Length > 300)
                {
                    reason = reason[..300];
                }
            }

            _logger.LogWarning(
                "REST transcription failed: {Status} {Body}",
                (int)response.StatusCode, body);
            throw new TranscriptionException(
                (int)response.StatusCode,
                reason.Length > 0 ? reason : "error");
        }

        return (ExtractText(responseBody), elapsedMs);
    }

    private static string ExtractText(string responseBody)
    {
        using var doc = JsonDocument.Parse(responseBody);
        var root = doc.RootElement;

        if (root.TryGetProperty("text", out var text) &&
            text.ValueKind == JsonValueKind.String)
        {
            return (text.GetString() ?? "").Trim();
        }

        return "";
    }
}
