using Microsoft.Extensions.Configuration;

namespace MarqSpec.FuturesLiquidityDashboard.Ingestion.ProjectX;

/// <summary>
/// The gateway's <c>POST /api/Auth/loginKey</c> body is <c>userName</c> plus <c>apiKey</c>.
/// Set one pair only. <c>PROJECTX_USERNAME</c> with <c>PROJECTX_API_KEY</c> is the loginKey pair and wins when
/// both pairs are present; <c>PROJECTX_API_SECRET</c> is then ignored.
/// <c>MarqSpec.Client.ProjectX</c> sends <c>ProjectX:ApiKey</c> / <c>PROJECTX_API_KEY</c> as <c>userName</c>
/// and <c>ProjectX:ApiSecret</c> / <c>PROJECTX_API_SECRET</c> as <c>apiKey</c>. The older pair still works when
/// <c>PROJECTX_USERNAME</c> is absent: <c>PROJECTX_API_KEY</c> is the user name and <c>PROJECTX_API_SECRET</c> is
/// the api key. This type lines the process environment up with what the client sends. Values are never written to a log.
/// </summary>
public static class ProjectXLogin
{
    public readonly record struct Pair(string UserName, string ApiKey);

    public static bool TryResolve(Func<string, string?> read, out Pair pair)
    {
        ArgumentNullException.ThrowIfNull(read);
        var username = read("PROJECTX_USERNAME");
        var apiKey = First(read("PROJECTX_API_KEY"), read("ProjectX:ApiKey"), read("ProjectX__ApiKey"));
        var secret = First(read("PROJECTX_API_SECRET"), read("ProjectX:ApiSecret"), read("ProjectX__ApiSecret"));
        if (!string.IsNullOrWhiteSpace(username) && !string.IsNullOrWhiteSpace(apiKey))
        {
            pair = new Pair(username, apiKey);
            return true;
        }

        if (!string.IsNullOrWhiteSpace(apiKey) && !string.IsNullOrWhiteSpace(secret))
        {
            pair = new Pair(apiKey, secret);
            return true;
        }

        pair = default;
        return false;
    }

    public static bool HasCredentials(IConfiguration configuration)
    {
        ArgumentNullException.ThrowIfNull(configuration);
        return TryResolve(key => configuration[key], out _);
    }

    /// <summary>
    /// When <c>PROJECTX_USERNAME</c> is set, copy it into <c>PROJECTX_API_KEY</c> and the real key into
    /// <c>PROJECTX_API_SECRET</c> so the client library's loginKey call sends them in the documented fields.
    /// </summary>
    public static void AlignProcessEnvironment()
    {
        var username = Environment.GetEnvironmentVariable("PROJECTX_USERNAME");
        var apiKey = Environment.GetEnvironmentVariable("PROJECTX_API_KEY");
        if (string.IsNullOrWhiteSpace(username) || string.IsNullOrWhiteSpace(apiKey))
        {
            return;
        }

        Environment.SetEnvironmentVariable("PROJECTX_API_SECRET", apiKey);
        Environment.SetEnvironmentVariable("PROJECTX_API_KEY", username);
    }

    private static string? First(params string?[] values) => values.FirstOrDefault(v => !string.IsNullOrWhiteSpace(v));
}
