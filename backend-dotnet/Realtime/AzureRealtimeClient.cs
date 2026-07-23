using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using TranscribeApi.Config;

namespace TranscribeApi.Realtime;

/// <summary>
/// Thin client over the Azure OpenAI Realtime transcription WebSocket.
///
/// Responsibilities:
///  - open the upstream <see cref="ClientWebSocket"/> with the <c>api-key</c> header,
///  - send the initial <c>transcription_session.update</c>,
///  - stream microphone audio up via <c>input_audio_buffer.append</c>,
///  - parse inbound Azure events and raise strongly-typed callbacks.
///
/// Azure realtime frames can be large and split across receive buffers, so the
/// receive loop accumulates fragments until <c>EndOfMessage</c> before parsing JSON.
/// </summary>
public sealed class AzureRealtimeClient : IAsyncDisposable
{
    private readonly AzureOptions _options;
    private readonly ILogger _logger;
    private readonly ClientWebSocket _socket = new();
    private readonly SemaphoreSlim _sendLock = new(1, 1);

    // Running concatenation of transcription deltas, keyed by Azure item_id.
    private readonly Dictionary<string, StringBuilder> _partials = new();

    // ---- Callbacks (wired by the session orchestrator) ----
    public event Action<string, string>? PartialTranscript; // (itemId, runningText)
    public event Action<string, string>? FinalTranscript;   // (itemId, transcript)
    public event Action? SpeechStarted;
    public event Action? SpeechStopped;
    public event Action<string>? Error;                     // (message)

    public AzureRealtimeClient(AzureOptions options, ILogger logger)
    {
        _options = options;
        _logger = logger;
    }

    public WebSocketState State => _socket.State;

    /// <summary>
    /// Connect to Azure and send the transcription session configuration.
    /// <paramref name="inputLanguage"/> is the ISO-639-1 code of the spoken audio;
    /// pass <c>null</c> or "auto" to let Azure auto-detect (the field is omitted).
    /// </summary>
    public async Task ConnectAsync(string? inputLanguage, CancellationToken ct)
    {
        _socket.Options.SetRequestHeader("api-key", _options.ApiKey);

        var uri = new Uri(_options.RealtimeWsUrl);
        await _socket.ConnectAsync(uri, ct).ConfigureAwait(false);

        await SendSessionUpdateAsync(inputLanguage, ct).ConfigureAwait(false);
    }

    /// <summary>
    /// Re-send the transcription session configuration to change the input
    /// language mid-stream (the socket stays open). Used when the client's
    /// <c>start</c> names a concrete language after we connected with auto-detect.
    /// </summary>
    public Task ReconfigureLanguageAsync(string? inputLanguage, CancellationToken ct)
        => SendSessionUpdateAsync(inputLanguage, ct);

    private async Task SendSessionUpdateAsync(string? inputLanguage, CancellationToken ct)
    {
        // Omit language entirely when auto-detecting; otherwise send the ISO code.
        var normalized = NormalizeLanguage(inputLanguage);

        var transcription = new Dictionary<string, object?>
        {
            ["model"] = _options.TranscribeDeployment,
            ["prompt"] = "",
        };
        if (normalized is not null)
        {
            transcription["language"] = normalized;
        }

        var payload = new Dictionary<string, object?>
        {
            ["type"] = "transcription_session.update",
            ["session"] = new Dictionary<string, object?>
            {
                ["input_audio_format"] = "pcm16",
                ["input_audio_transcription"] = transcription,
                ["turn_detection"] = new Dictionary<string, object?>
                {
                    ["type"] = "server_vad",
                    ["threshold"] = _options.VadThreshold,
                    ["prefix_padding_ms"] = _options.VadPrefixPaddingMs,
                    ["silence_duration_ms"] = _options.VadSilenceDurationMs,
                },
                ["input_audio_noise_reduction"] = new Dictionary<string, object?>
                {
                    ["type"] = "near_field",
                },
            },
        };

        await SendJsonAsync(payload, ct).ConfigureAwait(false);
    }

    /// <summary>Forward a raw PCM16 audio chunk to Azure as a base64 append.</summary>
    public async Task AppendAudioAsync(byte[] pcm, CancellationToken ct)
    {
        if (_socket.State != WebSocketState.Open)
        {
            return;
        }

        var payload = new Dictionary<string, object?>
        {
            ["type"] = "input_audio_buffer.append",
            ["audio"] = Convert.ToBase64String(pcm),
        };
        await SendJsonAsync(payload, ct).ConfigureAwait(false);
    }

    private async Task SendJsonAsync(object payload, CancellationToken ct)
    {
        var json = JsonSerializer.Serialize(payload);
        var bytes = Encoding.UTF8.GetBytes(json);

        await _sendLock.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            if (_socket.State == WebSocketState.Open)
            {
                await _socket.SendAsync(
                    new ArraySegment<byte>(bytes),
                    WebSocketMessageType.Text,
                    endOfMessage: true,
                    ct).ConfigureAwait(false);
            }
        }
        finally
        {
            _sendLock.Release();
        }
    }

    /// <summary>
    /// Read Azure events until the socket closes or <paramref name="ct"/> fires.
    /// Fragments are accumulated until <c>EndOfMessage</c> before JSON parsing.
    /// </summary>
    public async Task ReceiveLoopAsync(CancellationToken ct)
    {
        var buffer = new byte[64 * 1024];
        using var message = new MemoryStream();

        while (!ct.IsCancellationRequested && _socket.State == WebSocketState.Open)
        {
            WebSocketReceiveResult result;
            try
            {
                result = await _socket.ReceiveAsync(new ArraySegment<byte>(buffer), ct)
                    .ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                break;
            }
            catch (WebSocketException ex)
            {
                _logger.LogDebug(ex, "Upstream receive ended");
                break;
            }

            if (result.MessageType == WebSocketMessageType.Close)
            {
                _logger.LogDebug(
                    "Azure closed upstream: {Status} {Description}",
                    result.CloseStatus, result.CloseStatusDescription);
                break;
            }

            message.Write(buffer, 0, result.Count);

            if (!result.EndOfMessage)
            {
                continue;
            }

            var text = Encoding.UTF8.GetString(message.GetBuffer(), 0, (int)message.Length);
            message.SetLength(0);

            HandleEvent(text);
        }
    }

    private void HandleEvent(string json)
    {
        JsonElement root;
        try
        {
            using var doc = JsonDocument.Parse(json);
            root = doc.RootElement.Clone();
        }
        catch (JsonException ex)
        {
            _logger.LogWarning(ex, "Failed to parse Azure event");
            return;
        }

        if (!root.TryGetProperty("type", out var typeEl) ||
            typeEl.ValueKind != JsonValueKind.String)
        {
            return;
        }

        var type = typeEl.GetString();
        switch (type)
        {
            case "conversation.item.input_audio_transcription.delta":
            {
                var itemId = GetString(root, "item_id");
                var delta = GetString(root, "delta") ?? "";
                if (itemId is null)
                {
                    return;
                }

                if (!_partials.TryGetValue(itemId, out var sb))
                {
                    sb = new StringBuilder();
                    _partials[itemId] = sb;
                }
                sb.Append(delta);
                PartialTranscript?.Invoke(itemId, sb.ToString());
                break;
            }

            case "conversation.item.input_audio_transcription.completed":
            {
                var itemId = GetString(root, "item_id");
                if (itemId is null)
                {
                    return;
                }

                // Prefer Azure's authoritative transcript; fall back to accumulated deltas.
                var transcript = GetString(root, "transcript");
                if (string.IsNullOrEmpty(transcript) &&
                    _partials.TryGetValue(itemId, out var sb))
                {
                    transcript = sb.ToString();
                }
                _partials.Remove(itemId);
                FinalTranscript?.Invoke(itemId, transcript ?? "");
                break;
            }

            case "input_audio_buffer.speech_started":
                SpeechStarted?.Invoke();
                break;

            case "input_audio_buffer.speech_stopped":
                SpeechStopped?.Invoke();
                break;

            case "error":
            {
                var msg = "azure realtime error";
                if (root.TryGetProperty("error", out var errEl))
                {
                    if (errEl.ValueKind == JsonValueKind.Object &&
                        errEl.TryGetProperty("message", out var m) &&
                        m.ValueKind == JsonValueKind.String)
                    {
                        msg = m.GetString() ?? msg;
                    }
                    else if (errEl.ValueKind == JsonValueKind.String)
                    {
                        msg = errEl.GetString() ?? msg;
                    }
                }
                Error?.Invoke(msg);
                break;
            }

            default:
                // transcription_session.created / .updated and other events are ignored.
                break;
        }
    }

    /// <summary>Close the upstream socket cleanly (best-effort).</summary>
    public async Task CloseAsync(CancellationToken ct)
    {
        try
        {
            if (_socket.State == WebSocketState.Open ||
                _socket.State == WebSocketState.CloseReceived)
            {
                await _socket.CloseAsync(
                    WebSocketCloseStatus.NormalClosure, "client stop", ct)
                    .ConfigureAwait(false);
            }
        }
        catch (Exception ex)
        {
            _logger.LogDebug(ex, "Error closing upstream socket");
        }
    }

    public async ValueTask DisposeAsync()
    {
        try
        {
            if (_socket.State == WebSocketState.Open)
            {
                using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(2));
                await _socket.CloseAsync(
                    WebSocketCloseStatus.NormalClosure, "dispose", cts.Token)
                    .ConfigureAwait(false);
            }
        }
        catch
        {
            // Best-effort during disposal.
        }
        finally
        {
            _socket.Dispose();
            _sendLock.Dispose();
        }
    }

    private static string? NormalizeLanguage(string? lang)
    {
        if (string.IsNullOrWhiteSpace(lang))
        {
            return null;
        }
        var trimmed = lang.Trim();
        return trimmed.Equals("auto", StringComparison.OrdinalIgnoreCase) ? null : trimmed;
    }

    private static string? GetString(JsonElement obj, string name)
    {
        return obj.TryGetProperty(name, out var el) && el.ValueKind == JsonValueKind.String
            ? el.GetString()
            : null;
    }
}
