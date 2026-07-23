using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using System.Threading.Channels;
using TranscribeApi.Config;
using TranscribeApi.Models;

namespace TranscribeApi.Realtime;

/// <summary>
/// Orchestrates a single client WebSocket session end-to-end:
///
///  - opens and configures the upstream Azure realtime connection with
///    auto-detect, then emits <c>ready</c> (per the protocol sequence, <c>ready</c>
///    precedes the client's <c>start</c>),
///  - handles <c>start</c> (reconfiguring the input language when one is named),
///    then relays audio up and transcripts/translations down,
///  - translates finalized segments on a background task (never blocking the
///    <c>final_transcript</c> send),
///  - cleans up robustly on stop, disconnect, or error without crashing the server.
///
/// All outbound frames flow through a single unbounded channel drained by one
/// writer task, which both serializes access to the client socket (only one
/// <c>SendAsync</c> may run at a time) and preserves ordering
/// (partial → final → translation for a given itemId).
/// </summary>
public sealed class TranscriptionSession
{
    private readonly WebSocket _client;
    private readonly AzureOptions _options;
    private readonly TranslationService _translation;
    private readonly ILogger _logger;

    private readonly Channel<ServerMessage> _outbound =
        Channel.CreateUnbounded<ServerMessage>(new UnboundedChannelOptions
        {
            SingleReader = true,
        });

    private readonly SemaphoreSlim _clientSendLock = new(1, 1);

    // Session language state (mutable via `start` / `update`).
    private string? _inputLanguage;
    private string _targetLanguage = "en";
    private volatile bool _translate = true;

    // What input language Azure is currently configured with (null = auto-detect).
    private string? _configuredLanguage;

    public TranscriptionSession(
        WebSocket client,
        AzureOptions options,
        TranslationService translation,
        ILogger logger)
    {
        _client = client;
        _options = options;
        _translation = translation;
        _logger = logger;
    }

    public async Task RunAsync(CancellationToken serverToken)
    {
        using var cts = CancellationTokenSource.CreateLinkedTokenSource(serverToken);
        var ct = cts.Token;

        // Start the single outbound writer that owns the client socket.
        var writerTask = OutboundWriterAsync(ct);

        AzureRealtimeClient? azure = null;
        Task? azureReceiveTask = null;

        try
        {
            // 1. Open + configure the upstream Azure session with auto-detect so we
            //    can emit `ready` before the client's `start` (protocol sequence).
            azure = new AzureRealtimeClient(_options, _logger);
            WireAzureEvents(azure, ct);

            try
            {
                await azure.ConnectAsync(null, ct).ConfigureAwait(false);
                _configuredLanguage = null;
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Failed to connect upstream Azure realtime session");
                Enqueue(ServerMessage.Error($"azure connection failed: {ex.Message}"));
                return;
            }

            azureReceiveTask = azure.ReceiveLoopAsync(ct);

            // 2. Configured — tell the client it may send `start` and stream audio.
            Enqueue(ServerMessage.Ready());

            // 3. Handle start / audio / update / stop until disconnect.
            await ClientReadLoopAsync(azure, ct).ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            // Normal shutdown path.
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Transcription session error");
            TryEnqueue(ServerMessage.Error($"session error: {ex.Message}"));
        }
        finally
        {
            cts.Cancel();

            if (azure is not null)
            {
                await azure.CloseAsync(CancellationToken.None).ConfigureAwait(false);
            }

            // Signal the writer to drain and stop, then wait for it.
            _outbound.Writer.TryComplete();
            try
            {
                await writerTask.ConfigureAwait(false);
            }
            catch (Exception ex)
            {
                _logger.LogDebug(ex, "Outbound writer ended with error");
            }

            if (azureReceiveTask is not null)
            {
                try
                {
                    await azureReceiveTask.ConfigureAwait(false);
                }
                catch (Exception ex)
                {
                    _logger.LogDebug(ex, "Azure receive loop ended with error");
                }
            }

            if (azure is not null)
            {
                await azure.DisposeAsync().ConfigureAwait(false);
            }

            await CloseClientAsync().ConfigureAwait(false);
            _clientSendLock.Dispose();
        }
    }

    private void WireAzureEvents(AzureRealtimeClient azure, CancellationToken ct)
    {
        azure.PartialTranscript += (itemId, text) =>
            Enqueue(ServerMessage.PartialTranscript(itemId, text));

        azure.FinalTranscript += (itemId, text) =>
        {
            // Send the final transcript first, then translate off the hot path.
            Enqueue(ServerMessage.FinalTranscript(itemId, text));

            if (_translate && !string.IsNullOrWhiteSpace(text))
            {
                _ = TranslateInBackgroundAsync(itemId, text, _targetLanguage, ct);
            }
        };

        azure.SpeechStarted += () => Enqueue(ServerMessage.SpeechStarted());
        azure.SpeechStopped += () => Enqueue(ServerMessage.SpeechStopped());
        azure.Error += message => Enqueue(ServerMessage.Error(message));
    }

    private async Task TranslateInBackgroundAsync(
        string itemId, string text, string targetLanguage, CancellationToken ct)
    {
        try
        {
            var translated = await _translation
                .TranslateAsync(text, targetLanguage, ct)
                .ConfigureAwait(false);

            if (!string.IsNullOrEmpty(translated))
            {
                Enqueue(ServerMessage.Translation(itemId, translated, partial: false));
            }
        }
        catch (OperationCanceledException)
        {
            // Session ended; drop the translation silently.
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Translation failed for item {ItemId}", itemId);
            TryEnqueue(ServerMessage.Error($"translation failed: {ex.Message}"));
        }
    }

    /// <summary>
    /// Apply a <c>start</c> message: record target language / translate flag, and
    /// reconfigure the upstream input language when a concrete one is named
    /// (Azure was connected with auto-detect so <c>ready</c> could fire first).
    /// </summary>
    private async Task ApplyStartAsync(
        AzureRealtimeClient azure, ClientMessage msg, CancellationToken ct)
    {
        _inputLanguage = msg.InputLanguage;
        if (!string.IsNullOrWhiteSpace(msg.TargetLanguage))
        {
            _targetLanguage = msg.TargetLanguage!;
        }
        _translate = msg.Translate ?? true;

        var normalized = NormalizeLanguage(_inputLanguage);
        if (normalized == _configuredLanguage)
        {
            return;
        }

        try
        {
            await azure.ReconfigureLanguageAsync(normalized, ct).ConfigureAwait(false);
            _configuredLanguage = normalized;
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Failed to reconfigure input language");
            Enqueue(ServerMessage.Info("could not apply input language; using auto-detect"));
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

    private async Task ClientReadLoopAsync(AzureRealtimeClient azure, CancellationToken ct)
    {
        while (!ct.IsCancellationRequested && _client.State == WebSocketState.Open)
        {
            var frame = await ReceiveFrameAsync(ct).ConfigureAwait(false);
            if (frame.Closed)
            {
                return;
            }

            if (frame.Type == WebSocketMessageType.Binary)
            {
                await azure.AppendAudioAsync(frame.Data, ct).ConfigureAwait(false);
                continue;
            }

            // Text control frame.
            var msg = ParseClientMessage(frame.Data);
            if (msg is null)
            {
                continue;
            }

            switch (msg.Type)
            {
                case "stop":
                    return;

                case "start":
                    await ApplyStartAsync(azure, msg, ct).ConfigureAwait(false);
                    break;

                case "update":
                    ApplyUpdate(msg);
                    break;

                default:
                    _logger.LogDebug("Ignoring unknown client message type {Type}", msg.Type);
                    break;
            }
        }
    }

    private void ApplyUpdate(ClientMessage msg)
    {
        var changed = false;

        if (!string.IsNullOrWhiteSpace(msg.TargetLanguage) &&
            msg.TargetLanguage != _targetLanguage)
        {
            _targetLanguage = msg.TargetLanguage!;
            changed = true;
            Enqueue(ServerMessage.Info($"target language changed to {_targetLanguage}"));
        }

        if (msg.Translate.HasValue && msg.Translate.Value != _translate)
        {
            _translate = msg.Translate.Value;
            changed = true;
            Enqueue(ServerMessage.Info(
                _translate ? "translation enabled" : "translation disabled"));
        }

        if (!changed)
        {
            _logger.LogDebug("Update frame produced no changes");
        }
    }

    // ---- Outbound plumbing ----

    private void Enqueue(ServerMessage msg) => _outbound.Writer.TryWrite(msg);

    private void TryEnqueue(ServerMessage msg)
    {
        // Same as Enqueue but explicitly tolerant of a completed channel.
        _outbound.Writer.TryWrite(msg);
    }

    private async Task OutboundWriterAsync(CancellationToken ct)
    {
        try
        {
            await foreach (var msg in _outbound.Reader.ReadAllAsync(ct).ConfigureAwait(false))
            {
                await SendToClientAsync(msg, ct).ConfigureAwait(false);
            }
        }
        catch (OperationCanceledException)
        {
            // Expected on shutdown.
        }
        catch (Exception ex)
        {
            _logger.LogDebug(ex, "Outbound writer terminated");
        }
    }

    private async Task SendToClientAsync(ServerMessage msg, CancellationToken ct)
    {
        if (_client.State != WebSocketState.Open)
        {
            return;
        }

        var bytes = Encoding.UTF8.GetBytes(msg.ToJson());

        await _clientSendLock.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            if (_client.State == WebSocketState.Open)
            {
                await _client.SendAsync(
                    new ArraySegment<byte>(bytes),
                    WebSocketMessageType.Text,
                    endOfMessage: true,
                    ct).ConfigureAwait(false);
            }
        }
        catch (Exception ex)
        {
            _logger.LogDebug(ex, "Failed to send frame to client");
        }
        finally
        {
            _clientSendLock.Release();
        }
    }

    private async Task CloseClientAsync()
    {
        try
        {
            if (_client.State == WebSocketState.Open ||
                _client.State == WebSocketState.CloseReceived)
            {
                using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(2));
                await _client.CloseAsync(
                    WebSocketCloseStatus.NormalClosure, "session ended", cts.Token)
                    .ConfigureAwait(false);
            }
        }
        catch (Exception ex)
        {
            _logger.LogDebug(ex, "Error closing client socket");
        }
    }

    // ---- Frame reception ----

    private readonly record struct Frame(WebSocketMessageType Type, byte[] Data, bool Closed);

    /// <summary>
    /// Receive one complete WebSocket message, accumulating fragments until
    /// <c>EndOfMessage</c>. Returns a closed sentinel on Close or transport error.
    /// </summary>
    private async Task<Frame> ReceiveFrameAsync(CancellationToken ct)
    {
        var buffer = new byte[32 * 1024];
        using var ms = new MemoryStream();
        WebSocketMessageType type = WebSocketMessageType.Text;

        while (true)
        {
            WebSocketReceiveResult result;
            try
            {
                result = await _client.ReceiveAsync(new ArraySegment<byte>(buffer), ct)
                    .ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                return new Frame(WebSocketMessageType.Close, Array.Empty<byte>(), true);
            }
            catch (WebSocketException ex)
            {
                _logger.LogDebug(ex, "Client receive ended");
                return new Frame(WebSocketMessageType.Close, Array.Empty<byte>(), true);
            }

            if (result.MessageType == WebSocketMessageType.Close)
            {
                return new Frame(WebSocketMessageType.Close, Array.Empty<byte>(), true);
            }

            type = result.MessageType;
            ms.Write(buffer, 0, result.Count);

            if (result.EndOfMessage)
            {
                return new Frame(type, ms.ToArray(), false);
            }
        }
    }

    private ClientMessage? ParseClientMessage(byte[] data)
    {
        try
        {
            return JsonSerializer.Deserialize<ClientMessage>(data);
        }
        catch (JsonException ex)
        {
            _logger.LogDebug(ex, "Failed to parse client control frame");
            return null;
        }
    }
}
