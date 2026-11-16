using MarqSpec.FuturesLiquidityDashboard.Core.Instruments;

namespace MarqSpec.FuturesLiquidityDashboard.Core.Overlays;

/// <summary>Why an overlay version was refused.</summary>
public enum OverlayRejection
{
    None,
    UnsupportedSchema,
    WrongContract,
    Expired,
    NotYetValid,
    StaleVersion,
    InvalidLevel,
    TooLarge,
}

/// <summary>The outcome of publishing: accepted (or an idempotent repeat), or rejected with a reason.</summary>
public sealed record OverlayResult(bool Accepted, OverlayRejection Rejection, string Message, Overlay? Overlay)
{
    public static OverlayResult Reject(OverlayRejection reason, string message) => new(false, reason, message, null);
}

/// <summary>
/// Holds the newest valid overlay version per instrument (ARCHITECTURE.md, Overlay intake; REQUIREMENTS.md FR-8).
/// Stale, expired, future-dated and wrong-contract versions are rejected with a reason; a repeat of the current
/// version is idempotent. The store never touches market data. Thread-safe. <paramref name="specs"/> gives the
/// contract each instrument is actually streaming (for example the front month the feed resolved), which an overlay
/// must name; it defaults to the catalog.
/// </summary>
public sealed class OverlayStore(TimeProvider time, Func<InstrumentRoot, InstrumentSpec>? specs = null)
{
    public const int MaxLevels = 50;
    public const int MaxRationaleLength = 2000;
    public const int MaxLabelLength = 80;
    public const int MaxQualityFlags = 10;

    private readonly Dictionary<InstrumentRoot, Overlay> _current = [];
    private readonly Lock _gate = new();

    public event Action<InstrumentRoot>? Changed;

    public OverlayResult Publish(InstrumentRoot root, OverlayRequest request, string publisher)
    {
        ArgumentNullException.ThrowIfNull(request);
        var spec = (specs ?? InstrumentCatalog.For)(root);
        var now = time.GetUtcNow();
        var invalid = Validate(spec, request, now);
        if (invalid is not null)
        {
            return invalid;
        }

        lock (_gate)
        {
            if (_current.TryGetValue(root, out var existing))
            {
                if (existing.Request.Version == request.Version)
                {
                    return new OverlayResult(true, OverlayRejection.None, "Version already current.", existing);
                }

                if (existing.Request.Version > request.Version)
                {
                    return OverlayResult.Reject(OverlayRejection.StaleVersion,
                        $"Version {request.Version} is older than the current version {existing.Request.Version}.");
                }
            }

            var overlay = new Overlay { Root = root, Request = request, Publisher = publisher, AvailableAt = now };
            _current[root] = overlay;
            Changed?.Invoke(root);
            return new OverlayResult(true, OverlayRejection.None, "Accepted.", overlay);
        }
    }

    /// <summary>The current overlay for an instrument, expired or not; callers mark expired levels.</summary>
    public Overlay? Current(InstrumentRoot root)
    {
        lock (_gate)
        {
            return _current.GetValueOrDefault(root);
        }
    }

    private static OverlayResult? Validate(InstrumentSpec spec, OverlayRequest request, DateTimeOffset now)
    {
        if (request.SchemaVersion != 1)
        {
            return OverlayResult.Reject(OverlayRejection.UnsupportedSchema, "Only schema version 1 is supported.");
        }

        if (!string.Equals(request.ContractId, spec.ContractId, StringComparison.Ordinal))
        {
            return OverlayResult.Reject(OverlayRejection.WrongContract,
                $"Contract {request.ContractId} is not the active contract {spec.ContractId}.");
        }

        if (request.ExpiresAt <= now)
        {
            return OverlayResult.Reject(OverlayRejection.Expired, "The overlay has already expired.");
        }

        if (request.GeneratedAt > now.AddSeconds(5) || request.AsOf > now.AddSeconds(5))
        {
            return OverlayResult.Reject(OverlayRejection.NotYetValid, "Generated or as-of time is in the future.");
        }

        // JSON null reaches the non-nullable properties, so a missing list or text is a validation error, not a 500.
        if (request.Levels is null || request.Rationale is null || request.QualityFlags is null)
        {
            return OverlayResult.Reject(OverlayRejection.InvalidLevel, "Levels, rationale and quality flags must not be null.");
        }

        // The overlay goes out in every delta to every subscriber, so every list and string has a cap.
        if (request.Levels.Count > MaxLevels
            || request.Rationale.Length > MaxRationaleLength
            || request.QualityFlags.Count > MaxQualityFlags
            || request.QualityFlags.Any(f => f is null || f.Length > MaxLabelLength))
        {
            return OverlayResult.Reject(OverlayRejection.TooLarge,
                $"At most {MaxLevels} levels, {MaxRationaleLength} characters of rationale and {MaxQualityFlags} quality flags of {MaxLabelLength} characters.");
        }

        foreach (var level in request.Levels)
        {
            if (level is null || level.Kind is null || level.Kind.Length > MaxLabelLength)
            {
                return OverlayResult.Reject(OverlayRejection.InvalidLevel, $"Each level needs a kind of at most {MaxLabelLength} characters.");
            }

            if (!spec.TryToTicks(level.Price, out _) || level.Price <= 0)
            {
                return OverlayResult.Reject(OverlayRejection.InvalidLevel, "A level price is not a valid tick increment.");
            }

            if (string.IsNullOrWhiteSpace(level.Label) || level.Label.Length > MaxLabelLength)
            {
                return OverlayResult.Reject(OverlayRejection.InvalidLevel, $"Each level needs a label of at most {MaxLabelLength} characters.");
            }
        }

        return request.SourceCoverage is < 0 or > 1
            ? OverlayResult.Reject(OverlayRejection.InvalidLevel, "Source coverage must be between 0 and 1.")
            : null;
    }
}
