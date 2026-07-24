using System.Diagnostics;

namespace TranscribeApi.Audio;

/// <summary>
/// Optional server-side audio enhancement via ffmpeg (REST path only). When a
/// request opts in and ffmpeg is available, the WAV is piped through a filter
/// chain (high-pass + denoise + loudness-normalize by default) before upload.
/// Everything degrades gracefully: if ffmpeg is missing, errors, or returns
/// nothing usable, the original audio is used unchanged.
/// </summary>
public sealed class AudioEnhancer
{
    private readonly ILogger<AudioEnhancer> _logger;
    private bool? _ffmpegAvailable;

    public AudioEnhancer(ILogger<AudioEnhancer> logger)
    {
        _logger = logger;
    }

    private bool FfmpegAvailable()
    {
        if (_ffmpegAvailable is not null) return _ffmpegAvailable.Value;

        try
        {
            using var probe = Process.Start(new ProcessStartInfo
            {
                FileName = "ffmpeg",
                Arguments = "-version",
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
            });
            probe?.WaitForExit(3000);
            _ffmpegAvailable = probe is not null;
        }
        catch
        {
            _ffmpegAvailable = false;
        }
        return _ffmpegAvailable.Value;
    }

    /// <summary>
    /// Run <paramref name="audio"/> (a WAV blob) through an ffmpeg filter chain.
    /// Returns <c>(processed, enhanced)</c>; on any failure returns the original
    /// audio with <c>enhanced == false</c>.
    /// </summary>
    public async Task<(byte[] Audio, bool Enhanced)> EnhanceAsync(
        byte[] audio, string filters, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(filters)) return (audio, false);
        if (!FfmpegAvailable())
        {
            _logger.LogInformation(
                "Audio enhancement requested but ffmpeg is not installed; skipping");
            return (audio, false);
        }

        var psi = new ProcessStartInfo
        {
            FileName = "ffmpeg",
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
        };
        foreach (var arg in new[]
                 {
                     "-hide_banner", "-loglevel", "error",
                     "-i", "pipe:0", "-af", filters,
                     "-ac", "1", "-ar", "24000", "-f", "wav", "pipe:1",
                 })
        {
            psi.ArgumentList.Add(arg);
        }

        try
        {
            using var proc = Process.Start(psi);
            if (proc is null) return (audio, false);

            // Feed stdin and drain stdout/stderr concurrently to avoid deadlock.
            var stdoutTask = ReadAllBytesAsync(proc.StandardOutput.BaseStream, ct);
            var stderrTask = proc.StandardError.ReadToEndAsync(ct);

            await proc.StandardInput.BaseStream.WriteAsync(audio, ct).ConfigureAwait(false);
            proc.StandardInput.Close();

            var outBytes = await stdoutTask.ConfigureAwait(false);
            var errText = await stderrTask.ConfigureAwait(false);
            await proc.WaitForExitAsync(ct).ConfigureAwait(false);

            if (proc.ExitCode != 0 || outBytes.Length == 0)
            {
                _logger.LogWarning(
                    "ffmpeg enhancement failed (exit={Exit}): {Detail}",
                    proc.ExitCode, Truncate(errText, 300));
                return (audio, false);
            }

            return (outBytes, true);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "ffmpeg audio enhancement errored; using original audio");
            return (audio, false);
        }
    }

    private static async Task<byte[]> ReadAllBytesAsync(Stream stream, CancellationToken ct)
    {
        using var ms = new MemoryStream();
        await stream.CopyToAsync(ms, ct).ConfigureAwait(false);
        return ms.ToArray();
    }

    private static string Truncate(string s, int max) =>
        string.IsNullOrEmpty(s) ? "" : (s.Length <= max ? s : s[..max]);
}
