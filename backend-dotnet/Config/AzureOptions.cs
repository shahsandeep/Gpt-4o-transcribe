namespace TranscribeApi.Config;

/// <summary>
/// Strongly-typed Azure OpenAI configuration, bound from environment variables.
///
/// The env var names match the shared repo-root <c>.env</c> (injected in Docker via
/// <c>env_file</c>). Defaults mirror the Python backend so both backends behave
/// identically when a variable is unset.
/// </summary>
public sealed class AzureOptions
{
    // --- Azure OpenAI resource ---
    public string Endpoint { get; init; } = "https://your-resource.openai.azure.com";
    public string ApiKey { get; init; } = "";

    // --- Realtime transcription deployment ---
    public string TranscribeDeployment { get; init; } = "gpt-4o-transcribe";
    public string RealtimeApiVersion { get; init; } = "2025-04-01-preview";

    // --- Chat deployment used for translation ---
    public string ChatDeployment { get; init; } = "gpt-4o";
    public string ChatApiVersion { get; init; } = "2024-10-21";

    // --- Server-side voice activity detection tuning ---
    public double VadThreshold { get; init; } = 0.5;
    public int VadPrefixPaddingMs { get; init; } = 300;
    public int VadSilenceDurationMs { get; init; } = 500;

    // --- Server ---
    public int Port { get; init; } = 8080;

    /// <summary>
    /// Build an <see cref="AzureOptions"/> from the process environment. Mirrors the
    /// aliases used by the Python backend's <c>Settings</c> class.
    /// </summary>
    public static AzureOptions FromEnvironment()
    {
        return new AzureOptions
        {
            Endpoint = Env("AZURE_OPENAI_ENDPOINT", "https://your-resource.openai.azure.com"),
            ApiKey = Env("AZURE_OPENAI_API_KEY", ""),

            TranscribeDeployment = Env("AZURE_TRANSCRIBE_DEPLOYMENT", "gpt-4o-transcribe"),
            RealtimeApiVersion = Env("AZURE_REALTIME_API_VERSION", "2025-04-01-preview"),

            ChatDeployment = Env("AZURE_CHAT_DEPLOYMENT", "gpt-4o"),
            ChatApiVersion = Env("AZURE_CHAT_API_VERSION", "2024-10-21"),

            VadThreshold = EnvDouble("VAD_THRESHOLD", 0.5),
            VadPrefixPaddingMs = EnvInt("VAD_PREFIX_PADDING_MS", 300),
            VadSilenceDurationMs = EnvInt("VAD_SILENCE_DURATION_MS", 500),

            Port = EnvInt("DOTNET_PORT", 8080),
        };
    }

    /// <summary>
    /// Endpoint with any scheme and trailing slash stripped, e.g.
    /// <c>x.openai.azure.com</c>.
    /// </summary>
    public string EndpointHost
    {
        get
        {
            var ep = Endpoint.Trim().TrimEnd('/');
            foreach (var scheme in new[] { "https://", "http://", "wss://", "ws://" })
            {
                if (ep.StartsWith(scheme, StringComparison.OrdinalIgnoreCase))
                {
                    ep = ep[scheme.Length..];
                    break;
                }
            }
            return ep;
        }
    }

    /// <summary>
    /// Upstream Azure Realtime transcription WebSocket URL.
    /// <c>https://x.openai.azure.com</c> -&gt;
    /// <c>wss://x.openai.azure.com/openai/realtime?api-version=&lt;ver&gt;&amp;intent=transcription</c>.
    /// </summary>
    public string RealtimeWsUrl =>
        $"wss://{EndpointHost}/openai/realtime" +
        $"?api-version={RealtimeApiVersion}" +
        $"&intent=transcription";

    /// <summary>
    /// Azure chat completions REST URL used for translation.
    /// <c>https://x.openai.azure.com/openai/deployments/&lt;chat&gt;/chat/completions?api-version=&lt;chatver&gt;</c>.
    /// </summary>
    public string TranslationUrl =>
        $"https://{EndpointHost}/openai/deployments/" +
        $"{ChatDeployment}/chat/completions" +
        $"?api-version={ChatApiVersion}";

    private static string Env(string name, string fallback)
    {
        var v = Environment.GetEnvironmentVariable(name);
        return string.IsNullOrWhiteSpace(v) ? fallback : v;
    }

    private static int EnvInt(string name, int fallback)
    {
        var v = Environment.GetEnvironmentVariable(name);
        return int.TryParse(v, out var parsed) ? parsed : fallback;
    }

    private static double EnvDouble(string name, double fallback)
    {
        var v = Environment.GetEnvironmentVariable(name);
        return double.TryParse(
            v,
            System.Globalization.NumberStyles.Float,
            System.Globalization.CultureInfo.InvariantCulture,
            out var parsed)
            ? parsed
            : fallback;
    }
}
