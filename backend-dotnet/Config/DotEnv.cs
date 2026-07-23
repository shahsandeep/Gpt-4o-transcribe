namespace TranscribeApi.Config;

/// <summary>
/// Minimal <c>.env</c> loader so the .NET backend picks up the shared repo-root
/// <c>.env</c> when run outside Docker (mirrors the Python backend's python-dotenv
/// behavior). Walks up from the current working directory looking for a <c>.env</c>
/// file and sets any <c>KEY=VALUE</c> pairs into the process environment WITHOUT
/// overwriting variables that are already set — real environment variables always win.
/// </summary>
public static class DotEnv
{
    public static void Load()
    {
        var path = FindEnvFile();
        if (path is null)
        {
            return;
        }

        foreach (var raw in File.ReadAllLines(path))
        {
            var line = raw.Trim();
            if (line.Length == 0 || line.StartsWith('#'))
            {
                continue;
            }

            var eq = line.IndexOf('=');
            if (eq <= 0)
            {
                continue;
            }

            var key = line[..eq].Trim();
            var value = line[(eq + 1)..].Trim();

            // Strip a single pair of surrounding quotes if present.
            if (value.Length >= 2 &&
                ((value[0] == '"' && value[^1] == '"') ||
                 (value[0] == '\'' && value[^1] == '\'')))
            {
                value = value[1..^1];
            }

            // Real environment variables (e.g. exported in the shell) take priority.
            if (string.IsNullOrEmpty(Environment.GetEnvironmentVariable(key)))
            {
                Environment.SetEnvironmentVariable(key, value);
            }
        }
    }

    private static string? FindEnvFile()
    {
        var dir = new DirectoryInfo(Directory.GetCurrentDirectory());
        for (var i = 0; i < 6 && dir is not null; i++)
        {
            var candidate = Path.Combine(dir.FullName, ".env");
            if (File.Exists(candidate))
            {
                return candidate;
            }
            dir = dir.Parent;
        }
        return null;
    }
}
