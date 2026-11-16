using MarqSpec.FuturesLiquidityDashboard.Core.Instruments;

namespace MarqSpec.FuturesLiquidityDashboard.Core.Overlays;

/// <summary>One advisory level: a price and a short label (INTERFACES.md Interface C).</summary>
public sealed record OverlayLevel
{
    public required decimal Price { get; init; }

    public required string Label { get; init; }

    /// <summary>Optional style hint: support, resistance, liquidity, reference.</summary>
    public string Kind { get; init; } = "reference";
}

/// <summary>An overlay version as an agent publishes it (REQUIREMENTS.md FR-8). Times are UTC.</summary>
public sealed record OverlayRequest
{
    public int SchemaVersion { get; init; } = 1;

    public required string ContractId { get; init; }

    public required long Version { get; init; }

    public required DateTimeOffset GeneratedAt { get; init; }

    public required DateTimeOffset AsOf { get; init; }

    public required DateTimeOffset ExpiresAt { get; init; }

    /// <summary>Share of the source window the agent had complete data for, 0–1.</summary>
    public double SourceCoverage { get; init; } = 1.0;

    public required IReadOnlyList<OverlayLevel> Levels { get; init; }

    /// <summary>Plain text, length-capped, always rendered as text (ARCHITECTURE.md T-3).</summary>
    public string Rationale { get; init; } = string.Empty;

    public IReadOnlyList<string> QualityFlags { get; init; } = [];
}

/// <summary>An accepted overlay version: the request plus who published it and when it became available.</summary>
public sealed record Overlay
{
    public required InstrumentRoot Root { get; init; }

    public required OverlayRequest Request { get; init; }

    public required string Publisher { get; init; }

    /// <summary>When the server accepted it: the overlay is never drawn before this instant (REQUIREMENTS.md FR-8).</summary>
    public required DateTimeOffset AvailableAt { get; init; }

    public bool IsExpired(DateTimeOffset now) => now >= Request.ExpiresAt;
}
