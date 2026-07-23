using System.Text.Json;
using System.Text.Json.Serialization;

namespace TranscribeApi.Models;

/// <summary>
/// Serialization helpers and DTOs for the client-facing WebSocket protocol.
/// All outbound messages are camelCase JSON per WEBSOCKET_PROTOCOL.md
/// (<c>type</c>, <c>itemId</c>, <c>text</c>, <c>partial</c>, <c>message</c>).
/// </summary>
public static class ProtocolJson
{
    /// <summary>Shared camelCase options for outbound serialization.</summary>
    public static readonly JsonSerializerOptions Options = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };
}

// ---- Inbound (client -> server) ----

/// <summary>
/// A parsed inbound control frame. Only the fields relevant across all message
/// types are modeled; unknown types are surfaced via <see cref="Type"/>.
/// </summary>
public sealed class ClientMessage
{
    [JsonPropertyName("type")]
    public string? Type { get; set; }

    [JsonPropertyName("inputLanguage")]
    public string? InputLanguage { get; set; }

    [JsonPropertyName("targetLanguage")]
    public string? TargetLanguage { get; set; }

    [JsonPropertyName("translate")]
    public bool? Translate { get; set; }
}

// ---- Outbound (server -> client) ----

/// <summary>
/// Outbound protocol message. Nulls are omitted at serialization time so, e.g.,
/// a <c>ready</c> frame emits only <c>{"type":"ready"}</c>.
/// </summary>
public sealed class ServerMessage
{
    [JsonPropertyName("type")]
    public string Type { get; set; } = "";

    [JsonPropertyName("itemId")]
    public string? ItemId { get; set; }

    [JsonPropertyName("text")]
    public string? Text { get; set; }

    [JsonPropertyName("partial")]
    public bool? Partial { get; set; }

    [JsonPropertyName("message")]
    public string? Message { get; set; }

    public string ToJson() => JsonSerializer.Serialize(this, ProtocolJson.Options);

    public static ServerMessage Ready() => new() { Type = "ready" };

    public static ServerMessage PartialTranscript(string itemId, string text) =>
        new() { Type = "partial_transcript", ItemId = itemId, Text = text };

    public static ServerMessage FinalTranscript(string itemId, string text) =>
        new() { Type = "final_transcript", ItemId = itemId, Text = text };

    public static ServerMessage Translation(string itemId, string text, bool partial = false) =>
        new() { Type = "translation", ItemId = itemId, Text = text, Partial = partial };

    public static ServerMessage SpeechStarted() => new() { Type = "speech_started" };

    public static ServerMessage SpeechStopped() => new() { Type = "speech_stopped" };

    public static ServerMessage Info(string message) =>
        new() { Type = "info", Message = message };

    public static ServerMessage Error(string message) =>
        new() { Type = "error", Message = message };
}
