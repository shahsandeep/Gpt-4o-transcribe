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

        var responseFormat = string.IsNullOrWhiteSpace(_options.TranscribeResponseFormat)
            ? "json"
            : _options.TranscribeResponseFormat;
        form.Add(new StringContent(responseFormat), "response_format");

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

    /// <summary>
    /// Turn an Azure transcription response into display text. Handles the flat
    /// <c>json</c> shape (<c>{"text": ...}</c>) and the <c>diarized_json</c> shape
    /// (<c>{"segments": [{"speaker": "A", "text": ...}, ...]}</c>) from
    /// gpt-4o-transcribe-diarize. Consecutive same-speaker segments merge into one
    /// "A: ..." line. Falls back to top-level <c>text</c> when there are no usable
    /// segments (Azure sometimes returns only that even for diarized_json).
    /// Behavior-identical to the Python <c>format_transcript</c>.
    /// </summary>
    private static string ExtractText(string responseBody)
    {
        using var doc = JsonDocument.Parse(responseBody);
        var root = doc.RootElement;

        if (root.ValueKind == JsonValueKind.Object &&
            root.TryGetProperty("segments", out var segments) &&
            segments.ValueKind == JsonValueKind.Array &&
            segments.GetArrayLength() > 0)
        {
            var lines = new List<string>();
            string? curSpeaker = null;
            var haveSpeaker = false; // distinguishes "no segment yet" from "speaker == null"
            var parts = new List<string>();

            void Flush()
            {
                if (parts.Count == 0) return;
                var prefix = string.IsNullOrEmpty(curSpeaker) ? "" : $"{curSpeaker}: ";
                lines.Add(prefix + string.Join(" ", parts));
            }

            foreach (var seg in segments.EnumerateArray())
            {
                if (seg.ValueKind != JsonValueKind.Object) continue;
                var segText = seg.TryGetProperty("text", out var t) && t.ValueKind == JsonValueKind.String
                    ? (t.GetString() ?? "").Trim()
                    : "";
                if (segText.Length == 0) continue;

                var speaker = seg.TryGetProperty("speaker", out var sp) && sp.ValueKind == JsonValueKind.String
                    ? sp.GetString()
                    : null;

                if (haveSpeaker && speaker != curSpeaker && parts.Count > 0)
                {
                    Flush();
                    parts.Clear();
                }
                curSpeaker = speaker;
                haveSpeaker = true;
                parts.Add(segText);
            }
            Flush();

            var joined = string.Join("\n", lines).Trim();
            if (joined.Length > 0) return joined;
        }

        if (root.ValueKind == JsonValueKind.Object &&
            root.TryGetProperty("text", out var text) &&
            text.ValueKind == JsonValueKind.String)
        {
            return (text.GetString() ?? "").Trim();
        }

        return "";
    }
}
