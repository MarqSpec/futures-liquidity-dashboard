namespace MarqSpec.FuturesLiquidityDashboard.Core.Bars;

/// <summary>
/// Drops executions already accepted, by trade identifier, over a bounded memory of recent identifiers
/// (REQUIREMENTS.md FR-14, NFR-4).
/// </summary>
public sealed class TradeDeduplicator(int capacity = 200_000)
{
    private readonly HashSet<string> _seen = new(StringComparer.Ordinal);
    private readonly Queue<string> _order = new();

    public long Duplicates { get; private set; }

    /// <summary>True when the trade is new and should be applied.</summary>
    public bool Accept(string tradeId)
    {
        ArgumentException.ThrowIfNullOrEmpty(tradeId);
        if (!_seen.Add(tradeId))
        {
            Duplicates++;
            return false;
        }

        _order.Enqueue(tradeId);
        if (_order.Count > capacity)
        {
            _seen.Remove(_order.Dequeue());
        }

        return true;
    }
}
