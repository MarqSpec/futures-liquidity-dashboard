using System.Text.RegularExpressions;

namespace MarqSpec.FuturesLiquidityDashboard.Api.Auth;

/// <summary>
/// Strips viewer keys and bearer tokens out of text before it is written anywhere (CONVENTIONS.md §11).
/// The market hub has to carry <c>access_token</c> on the WebSocket URL, and the hosting request log includes the
/// raw query string, so redaction is the boundary rather than a promise that the URL never holds the key.
/// </summary>
public static partial class SecretRedactor
{
    /// <summary>The same text with key material replaced. Null and empty stay empty.</summary>
    public static string Redact(string? message)
    {
        if (string.IsNullOrEmpty(message))
        {
            return string.Empty;
        }

        var text = AccessToken().Replace(message, "access_token=[redacted]");
        text = ApiKeyHeader().Replace(text, "$1[redacted]");
        text = Bearer().Replace(text, "$1[redacted]");
        return Jwt().Replace(text, "[redacted]");
    }

    // Space or tab around '=' so `{ access_token = key }` is redacted. A newline after '=' is not
    // whitespace here, so `access_token=\nNextLine` does not swallow the next line.
    [GeneratedRegex(@"access_token\s*=[ \t]*[^\s,}&""']+", RegexOptions.IgnoreCase)]
    private static partial Regex AccessToken();

    [GeneratedRegex(@"(X-Api-Key\s*[:=]\s*)[^&\s]+", RegexOptions.IgnoreCase)]
    private static partial Regex ApiKeyHeader();

    [GeneratedRegex(@"(Authorization\s*[:=]\s*Bearer\s+)[^&\s]+", RegexOptions.IgnoreCase)]
    private static partial Regex Bearer();

    // Header plus at most two segments, which may be empty (`alg:none`). A third segment such as `.example.com` stays.
    [GeneratedRegex(@"eyJ[A-Za-z0-9_\-]{10,}(?:\.[A-Za-z0-9_\-]*){0,2}")]
    private static partial Regex Jwt();
}
