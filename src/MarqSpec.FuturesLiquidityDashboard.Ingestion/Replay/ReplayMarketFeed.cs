using System.Runtime.CompilerServices;
using System.Text.Json;
using MarqSpec.FuturesLiquidityDashboard.Core.Instruments;
using MarqSpec.FuturesLiquidityDashboard.Core.Market;
using MarqSpec.FuturesLiquidityDashboard.Ingestion.Feeds;

namespace MarqSpec.FuturesLiquidityDashboard.Ingestion.Replay;

/// <summary>
/// Replays a JSON Lines file of normalized <see cref="MarketEvent"/>s (one event per line, the shape of
/// INTERFACES.md Interface A.5). Event times are rebased so the first event happens now and the spacing is
/// kept (divided by <c>Speed</c>); every event is relabelled REPLAY, so recorded data is never shown as LIVE. When
/// <c>Loop</c> is on, each pass starts with a book reset and a new epoch, and trade ids get a pass suffix so the
/// engine's de-duplication does not drop the next pass. Events for instruments that are not enabled are skipped.
/// </summary>
public sealed class ReplayMarketFeed(ReplayFeedOptions options, TimeProvider time) : IMarketDataFeed
{
    public string Name => "replay";

    public FeedProvenance Provenance => FeedProvenance.Replay;

    public async IAsyncEnumerable<MarketEvent> StreamAsync(
        IReadOnlyList<InstrumentSpec> instruments,
        [EnumeratorCancellation] CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(instruments);
        if (string.IsNullOrWhiteSpace(options.Path) || !File.Exists(options.Path))
        {
            throw new FileNotFoundException("Feed:Replay:Path must name an existing JSON Lines file.", options.Path);
        }

        var enabled = instruments.ToDictionary(i => i.Root);
        var pass = 0L;
        do
        {
            pass++;
            var events = await LoadAsync(options.Path, cancellationToken).ConfigureAwait(false);
            if (events.Count == 0)
            {
                yield break;
            }

            var firstSource = events[0].SourceTimeMs;
            var startNow = time.GetUtcNow().ToUnixTimeMilliseconds();
            foreach (var spec in instruments)
            {
                yield return Status(spec, startNow, pass);
            }

            foreach (var e in events)
            {
                if (!enabled.TryGetValue(e.Root, out var spec))
                {
                    continue;
                }

                var due = startNow + (long)((e.SourceTimeMs - firstSource) / options.Speed);
                var wait = due - time.GetUtcNow().ToUnixTimeMilliseconds();
                if (wait > 0)
                {
                    await Task.Delay(TimeSpan.FromMilliseconds(wait), time, cancellationToken).ConfigureAwait(false);
                }

                yield return Rebase(e, spec, due, pass);
            }

            if (options.Loop)
            {
                var resetAt = time.GetUtcNow().ToUnixTimeMilliseconds();
                foreach (var spec in instruments)
                {
                    yield return new BookResetEvent
                    {
                        Root = spec.Root,
                        ContractId = spec.ContractId,
                        SourceTimeMs = resetAt,
                        ReceivedTimeMs = resetAt,
                        Epoch = pass,
                        Sequence = 0,
                        Reason = "replay loop",
                    };
                }
            }
        }
        while (options.Loop && !cancellationToken.IsCancellationRequested);
    }

    /// <summary>Reads every event of a JSON Lines file; blank lines are skipped.</summary>
    public static async Task<IReadOnlyList<MarketEvent>> LoadAsync(string path, CancellationToken cancellationToken)
    {
        var events = new List<MarketEvent>();
        using var reader = new StreamReader(path);
        string? line;
        while ((line = await reader.ReadLineAsync(cancellationToken).ConfigureAwait(false)) is not null)
        {
            if (string.IsNullOrWhiteSpace(line))
            {
                continue;
            }

            events.Add(JsonSerializer.Deserialize(line, MarketEventJsonContext.Default.MarketEvent)
                ?? throw new InvalidDataException("A replay line was null."));
        }

        return events.OrderBy(e => e.SourceTimeMs).ThenBy(e => e.Sequence).ToList();
    }

    internal static MarketEvent Rebase(MarketEvent e, InstrumentSpec spec, long timeMs, long pass) => e switch
    {
        TradeEvent t => t with
        {
            ContractId = spec.ContractId,
            SourceTimeMs = timeMs,
            ReceivedTimeMs = timeMs,
            Epoch = pass,
            TradeId = pass == 1 ? t.TradeId : $"{t.TradeId}-L{pass}",
        },
        FeedStatusEvent s => s with { ContractId = spec.ContractId, SourceTimeMs = timeMs, ReceivedTimeMs = timeMs, Epoch = pass, Provenance = FeedProvenance.Replay },
        _ => e with { ContractId = spec.ContractId, SourceTimeMs = timeMs, ReceivedTimeMs = timeMs, Epoch = pass },
    };

    private static FeedStatusEvent Status(InstrumentSpec spec, long now, long pass) => new()
    {
        Root = spec.Root,
        ContractId = spec.ContractId,
        SourceTimeMs = now,
        ReceivedTimeMs = now,
        Epoch = pass,
        Sequence = 0,
        Connected = true,
        Provenance = FeedProvenance.Replay,
    };
}
