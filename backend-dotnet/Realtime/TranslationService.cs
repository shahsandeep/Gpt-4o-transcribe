using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using TranscribeApi.Config;

namespace TranscribeApi.Realtime;

/// <summary>
/// Translates finalized transcript segments via the Azure chat completions REST API.
/// </summary>
public sealed class TranslationService
{
    private readonly IHttpClientFactory _httpClientFactory;
    private readonly AzureOptions _options;
    private readonly ILogger<TranslationService> _logger;

    // Minimal ISO-639-1 -> language-name map. Falls back to the raw code when absent.
    private static readonly IReadOnlyDictionary<string, string> LanguageNames =
        new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
        {
            ["en"] = "English",
            ["es"] = "Spanish",
            ["fr"] = "French",
            ["de"] = "German",
            ["it"] = "Italian",
            ["pt"] = "Portuguese",
            ["nl"] = "Dutch",
            ["ru"] = "Russian",
            ["zh"] = "Chinese",
            ["ja"] = "Japanese",
            ["ko"] = "Korean",
            ["ar"] = "Arabic",
            ["hi"] = "Hindi",
            ["tr"] = "Turkish",
            ["pl"] = "Polish",
            ["sv"] = "Swedish",
            ["da"] = "Danish",
            ["no"] = "Norwegian",
            ["fi"] = "Finnish",
            ["cs"] = "Czech",
            ["el"] = "Greek",
            ["he"] = "Hebrew",
            ["th"] = "Thai",
            ["vi"] = "Vietnamese",
            ["id"] = "Indonesian",
            ["uk"] = "Ukrainian",
            ["ro"] = "Romanian",
            ["hu"] = "Hungarian",
        };

    public TranslationService(
        IHttpClientFactory httpClientFactory,
        AzureOptions options,
        ILogger<TranslationService> logger)
    {
        _httpClientFactory = httpClientFactory;
        _options = options;
        _logger = logger;
    }

    /// <summary>
    /// Translate <paramref name="text"/> into <paramref name="targetLanguage"/>
    /// (ISO-639-1). Returns the trimmed assistant content, or an empty string on
    /// empty input.
    /// </summary>
    public async Task<string> TranslateAsync(
        string text,
        string targetLanguage,
        CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(text))
        {
            return "";
        }

        var languageName = ResolveLanguageName(targetLanguage);
        var systemPrompt =
            $"You are a translation engine. Translate the user's text into {languageName}. " +
            "Output ONLY the translation, no explanations.";

        var body = new
        {
            messages = new object[]
            {
                new { role = "system", content = systemPrompt },
                new { role = "user", content = text },
            },
            temperature = 0,
        };

        var json = JsonSerializer.Serialize(body);

        using var request = new HttpRequestMessage(HttpMethod.Post, _options.TranslationUrl)
        {
            Content = new StringContent(json, Encoding.UTF8, "application/json"),
        };
        request.Headers.TryAddWithoutValidation("api-key", _options.ApiKey);
        request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));

        var client = _httpClientFactory.CreateClient("azure-chat");

        using var response = await client.SendAsync(request, ct).ConfigureAwait(false);
        var responseBody = await response.Content.ReadAsStringAsync(ct).ConfigureAwait(false);

        if (!response.IsSuccessStatusCode)
        {
            _logger.LogWarning(
                "Translation request failed: {Status} {Body}",
                (int)response.StatusCode, responseBody);
            throw new HttpRequestException(
                $"azure chat translation failed: {(int)response.StatusCode}");
        }

        return ExtractContent(responseBody);
    }

    /// <summary>Resolve an ISO code to its English language name, else the code itself.</summary>
    public static string ResolveLanguageName(string code)
    {
        if (string.IsNullOrWhiteSpace(code))
        {
            return code;
        }
        return LanguageNames.TryGetValue(code.Trim(), out var name) ? name : code.Trim();
    }

    private static string ExtractContent(string responseBody)
    {
        using var doc = JsonDocument.Parse(responseBody);
        var root = doc.RootElement;

        if (root.TryGetProperty("choices", out var choices) &&
            choices.ValueKind == JsonValueKind.Array &&
            choices.GetArrayLength() > 0)
        {
            var first = choices[0];
            if (first.TryGetProperty("message", out var message) &&
                message.TryGetProperty("content", out var content) &&
                content.ValueKind == JsonValueKind.String)
            {
                return (content.GetString() ?? "").Trim();
            }
        }

        return "";
    }
}
