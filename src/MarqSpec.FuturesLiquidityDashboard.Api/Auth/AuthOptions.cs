using MarqSpec.FuturesLiquidityDashboard.Core.Instruments;

namespace MarqSpec.FuturesLiquidityDashboard.Api.Auth;

/// <summary>
/// Viewer and agent access (REQUIREMENTS.md §2, NFR-6; ARCHITECTURE.md D-16). Each API key carries explicit grants of the
/// form <c>permission:scope</c>, for example <c>view-dashboard:*</c> or <c>publish-overlay:ES</c>. Only the SHA-256
/// of a key is configured, through the environment or user-secrets, never the key itself.
/// </summary>
public sealed class AuthOptions
{
    public const string Section = "Auth";

    public List<ApiKeyEntry> Keys { get; set; } = [];

    /// <summary>
    /// Grants given to a request that presents no key. Empty in production, so every request must authenticate;
    /// the Development settings grant a local viewer everything so the demo runs with one command.
    /// </summary>
    public List<string> AnonymousGrants { get; set; } = [];

    /// <summary>
    /// When true, <c>/health/ready</c>, <c>/metrics</c> and <c>/api/diagnostics/depth-width</c> require an authenticated caller. When false, they stay
    /// anonymous. When null, they require a caller outside Development and stay open in Development (D-30).
    /// The host reads this once at startup; a later change applies only after a restart.
    /// <c>/health/live</c> is always anonymous so a platform health check needs no key.
    /// </summary>
    public bool? ProtectDiagnostics { get; set; }

    /// <summary>Whether detailed readiness and metrics require an authenticated caller in this environment.</summary>
    public bool RequiresKeyForDiagnostics(bool isDevelopment) => ProtectDiagnostics ?? !isDevelopment;
}

public sealed class ApiKeyEntry
{
    public string Name { get; set; } = string.Empty;

    /// <summary>Lower-case hex SHA-256 of the key.</summary>
    public string KeySha256 { get; set; } = string.Empty;

    public List<string> Grants { get; set; } = [];
}

/// <summary>The five permissions of REQUIREMENTS.md §2. None of them places, changes or cancels an order (REQUIREMENTS.md FR-6).</summary>
public static class Permissions
{
    public const string ClaimType = "perm";
    public const string ViewDashboard = "view-dashboard";
    public const string ConfigureLayout = "configure-layout";
    public const string PublishOverlay = "publish-overlay";
    public const string ReadContext = "read-context";
    public const string RequestFeedback = "request-feedback";

    public static IReadOnlySet<string> All { get; } = new HashSet<string>(StringComparer.Ordinal)
    {
        ViewDashboard, ConfigureLayout, PublishOverlay, ReadContext, RequestFeedback,
    };

    /// <summary>True when <paramref name="grant"/> is <c>permission:scope</c> with a known permission and scope.</summary>
    public static bool IsValidGrant(string? grant)
    {
        if (string.IsNullOrWhiteSpace(grant))
        {
            return false;
        }

        var parts = grant.Split(':');
        return parts.Length == 2
            && All.Contains(parts[0])
            && (parts[1] == "*" || InstrumentCatalog.TryParse(parts[1], out _));
    }

    /// <summary>Grants are not inherited: only the exact permission with this instrument or <c>*</c> counts.</summary>
    public static bool Has(System.Security.Claims.ClaimsPrincipal user, string permission, InstrumentRoot root)
    {
        ArgumentNullException.ThrowIfNull(user);
        var exact = $"{permission}:{root}";
        var any = $"{permission}:*";
        return user.Claims.Any(c => c.Type == ClaimType && (c.Value == any || string.Equals(c.Value, exact, StringComparison.OrdinalIgnoreCase)));
    }
}
