using System.Text.Json.Serialization;

namespace MarqSpec.FuturesLiquidityDashboard.Core.Market;

/// <summary>Source-generated JSON for normalized events: the replay file format (one event per line).</summary>
[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase, UseStringEnumConverter = true)]
[JsonSerializable(typeof(MarketEvent))]
public sealed partial class MarketEventJsonContext : JsonSerializerContext;
