using System.Runtime.CompilerServices;
using System.Text.RegularExpressions;
using MarqSpec.Client.ProjectX;
using MarqSpec.Client.ProjectX.Api.Models;
using MarqSpec.Client.ProjectX.WebSocket;
using MarqSpec.FuturesLiquidityDashboard.Core.Engine;
using MarqSpec.FuturesLiquidityDashboard.Core.Instruments;
using MarqSpec.FuturesLiquidityDashboard.Core.Market;
using MarqSpec.FuturesLiquidityDashboard.Ingestion.Feeds;
using MarqSpec.FuturesLiquidityDashboard.Ingestion.Hosting;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;

namespace MarqSpec.FuturesLiquidityDashboard.Ingestion.ProjectX;

/// <summary>
/// TopstepX market data through the ProjectX gateway (ARCHITECTURE.md D-15): the production feed. It uses
/// <c>MarqSpec.Client.ProjectX</c> for authentication, contract lookup, one-minute history and the SignalR market
/// hub (<c>GatewayDepth</c>, <c>GatewayTrade</c>), and only ever subscribes to market data: it holds no account id
/// and calls nothing that places, changes or cancels an order (REQUIREMENTS.md FR-6).
/// <para>
/// The gateway's depth stream has no explicit snapshot message, so after every (re)subscription the feed collects
/// depth rows for <c>SnapshotSettleMs</c> into a private book and then emits one <see cref="DepthSnapshotEvent"/>;
/// until then the engine shows the book as unknown (RECOVERING), never a half-built book. A Reset row starts that
/// again. Callbacks hand events to a <see cref="MarketIngestBuffer"/>: trades wait for a slot, quotes and depth
/// collapse to the latest value, and an overflow restarts that settle window instead of growing without a bound
/// (ARCHITECTURE.md D-32). This settle approach and the default depth of <c>LevelsPerSide</c> are assumptions to
/// confirm in Stage 0 against the live gateway (ARCHITECTURE.md).
/// </para>
/// </summary>
public sealed partial class ProjectXMarketFeed : IMarketDataFeed, IHistoricalTradeSource, IMinuteBarSource, IInstrumentResolver
{
    private readonly ProjectXFeedOptions _options;
    private readonly IServiceScopeFactory _scopes;
    private readonly IProjectXWebSocketClient _socket;
    private readonly TimeProvider _time;
    private readonly ILogger<ProjectXMarketFeed> _logger;
    private readonly DepthDemand _depth;
    private readonly IngestBufferOptions _ingest;
    private readonly IngestMetrics? _metrics;
    private readonly object _stateGate = new();
    private readonly Lock _historyGate = new();
    private long _streamRuns;
    private long _nextHistoryMs = long.MinValue;
    private readonly Dictionary<string, InstrumentSpec> _byGatewayId = new(StringComparer.Ordinal);
    private readonly Dictionary<InstrumentRoot, string> _gatewayIds = [];

    /// <param name="depth">Which products get depth (REQUIREMENTS.md FR-54); every product when null.</param>
    /// <param name="ingest">Queue bounds (REQUIREMENTS.md NFR-4). The defaults when null.</param>
    /// <param name="metrics">Queue gauges. Omitted in tests that do not scrape them.</param>
    public ProjectXMarketFeed(
        ProjectXFeedOptions options,
        IServiceScopeFactory scopes,
        IProjectXWebSocketClient socket,
        TimeProvider time,
        ILogger<ProjectXMarketFeed> logger,
        DepthDemand? depth = null,
        IngestBufferOptions? ingest = null,
        IngestMetrics? metrics = null)
    {
        _options = options ?? throw new ArgumentNullException(nameof(options));
        _scopes = scopes ?? throw new ArgumentNullException(nameof(scopes));
        _socket = socket ?? throw new ArgumentNullException(nameof(socket));
        _time = time ?? throw new ArgumentNullException(nameof(time));
        _logger = logger ?? throw new ArgumentNullException(nameof(logger));
        _depth = depth ?? DepthDemand.Everything(time);
        _ingest = ingest ?? new IngestBufferOptions();
        _metrics = metrics;
    }

    /// <summary>The live ingest buffer while <see cref="StreamAsync"/> is running; null otherwise. Tests read its depth.</summary>
    internal MarketIngestBuffer? Pressure { get; private set; }

    /// <summary>Test hook. Runs at the start of each reader iteration, before the wait, so a test can enqueue without a timer.</summary>
    internal Action? BeforeRead { get; set; }

    public string Name => "projectx";

    public FeedProvenance Provenance => FeedProvenance.Live;

    /// <summary>
    /// Finds the gateway contract for each product (REQUIREMENTS.md FR-54). For a selection of every product it lists the
    /// gateway's available contracts once and keeps one per root: the configured id when one is set, otherwise the
    /// active contract whose name is root + month code, or whose symbol id is <c>F.US.{root}</c> when the name is
    /// not that shape, so ES never matches MES. For named roots it searches each one. Tick
    /// size and tick value come from the gateway, which wins over the catalog; a difference is logged. The catalog
    /// still gives name, exchange, sector and TPO row, and a root it does not list is shown under "Other".
    /// </summary>
    public async Task<IReadOnlyList<InstrumentSpec>> ResolveAsync(
        InstrumentSelection selection,
        IReadOnlyList<InstrumentSpec> current,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(selection);
        ArgumentNullException.ThrowIfNull(current);
        using var scope = _scopes.CreateScope();
        var api = scope.ServiceProvider.GetRequiredService<IProjectXApiClient>();
        var known = current.ToDictionary(s => s.Root);
        var picked = new List<(InstrumentRoot Root, Contract Contract)>();
        if (selection.All)
        {
            var listed = await api.GetAvailableContractsAsync(_options.SearchLive, cancellationToken).ConfigureAwait(false);
            foreach (var group in listed.Select(c => (Root: RootOf(c), Contract: c)).Where(c => c.Root is not null).GroupBy(c => c.Root!.Value))
            {
                if (!selection.Includes(group.Key))
                {
                    continue;
                }

                var contract = await Configured(api, group.Key, cancellationToken).ConfigureAwait(false)
                    ?? PickContract(group.Key, group.Select(g => g.Contract));
                if (contract is not null)
                {
                    picked.Add((group.Key, contract));
                }
            }

            if (picked.Count == 0)
            {
                throw new InvalidOperationException("ProjectX lists no available futures contracts.");
            }
        }
        else
        {
            foreach (var root in selection.Roots.Where(selection.Includes))
            {
                var contract = await Configured(api, root, cancellationToken).ConfigureAwait(false);
                if (contract is null)
                {
                    var found = await api.SearchContractsAsync(root.ToString(), _options.SearchLive, cancellationToken).ConfigureAwait(false);
                    contract = PickContract(root, found)
                        ?? throw new InvalidOperationException($"ProjectX lists no active {root} contract; set Feed:ProjectX:ContractIds:{root}.");
                }

                picked.Add((root, contract));
            }
        }

        var specs = picked
            .Select(p => (p.Contract, Spec: Bind(p.Root, p.Contract, known.GetValueOrDefault(p.Root))))
            .OrderBy(p => InstrumentCatalog.SectorOrder(p.Spec.Sector))
            .ThenBy(p => InstrumentCatalog.Order(p.Spec.Root))
            .ThenBy(p => p.Spec.Root)
            .ToList();
        if (_options.MaxContracts > 0 && specs.Count > _options.MaxContracts)
        {
            Log.ContractsCapped(_logger, specs.Count, _options.MaxContracts, string.Join(' ', specs.Skip(_options.MaxContracts).Select(p => p.Spec.Root)));
            specs = specs.Take(_options.MaxContracts).ToList();
        }

        _byGatewayId.Clear();
        _gatewayIds.Clear();
        foreach (var (contract, spec) in specs)
        {
            _byGatewayId[contract.Id] = spec;
            _gatewayIds[spec.Root] = contract.Id;
            Log.Resolved(_logger, spec.Root, contract.Id, contract.Name);
        }

        return specs.Select(p => p.Spec).ToList();
    }

    /// <summary>The root of a gateway contract name: <c>ESZ5</c> → ES, <c>M6EZ25</c> → M6E; null for anything else.</summary>
    public static InstrumentRoot? RootOf(string? contractName)
    {
        if (contractName is null)
        {
            return null;
        }

        var match = ContractName().Match(contractName);
        return match.Success && InstrumentRoot.TryParse(match.Groups["root"].Value, out var root) ? root : null;
    }

    /// <summary>
    /// The root of one available-contract row. The month-code name wins, so ES never matches MES. A name that is
    /// not that shape, such as "Micro Gold", uses the symbol id <c>F.US.{root}</c>.
    /// </summary>
    public static InstrumentRoot? RootOf(Contract contract)
    {
        ArgumentNullException.ThrowIfNull(contract);
        return RootOf(contract.Name) ?? RootOfSymbol(contract.SymbolId);
    }

    /// <summary>The root in a gateway symbol id <c>F.US.{root}</c>, or the product segment of <c>F.US.{root}.{month}</c>.</summary>
    public static InstrumentRoot? RootOfSymbol(string? symbolId)
    {
        const string prefix = "F.US.";
        if (string.IsNullOrWhiteSpace(symbolId) || !symbolId.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
        {
            return null;
        }

        var token = symbolId[prefix.Length..];
        var dot = token.IndexOf('.', StringComparison.Ordinal);
        if (dot >= 0)
        {
            token = token[..dot];
        }

        return InstrumentRoot.TryParse(token, out var root) ? root : null;
    }

    /// <summary>
    /// The active contract for a root: a name of root + month code, or symbol id <c>F.US.{root}</c>, preferring
    /// <c>activeContract</c>.
    /// </summary>
    public static Contract? PickContract(InstrumentRoot root, IEnumerable<Contract> contracts)
    {
        ArgumentNullException.ThrowIfNull(contracts);
        var matching = contracts.Where(c => BelongsTo(root, c)).ToList();
        return matching.FirstOrDefault(c => c.ActiveContract) ?? matching.OrderBy(c => c.Name, StringComparer.Ordinal).FirstOrDefault();
    }

    /// <summary>
    /// A contract belongs to the root when its name is the root plus a month code, or its symbol id is the
    /// gateway product id <c>F.US.{root}</c> (gateway.docs.projectx.com, GatewayQuote <c>symbol</c>).
    /// </summary>
    internal static bool BelongsTo(InstrumentRoot root, Contract contract)
    {
        ArgumentNullException.ThrowIfNull(contract);
        if (RootOf(contract.Name) == root)
        {
            return true;
        }

        return RootOfSymbol(contract.SymbolId) == root && RootOf(contract.Name) is null;
    }

    /// <summary>
    /// The spec for a gateway contract: the gateway's tick size and tick value, the catalog's (or the current
    /// spec's) name, exchange, sector and TPO row, and the contract month from the name as the expiry (the gateway
    /// gives no expiry date).
    /// </summary>
    internal InstrumentSpec Bind(InstrumentRoot root, Contract contract, InstrumentSpec? current)
    {
        var template = current ?? (InstrumentCatalog.TryGet(root, out var listed) ? listed : null);
        var tickSize = contract.TickSize > 0 ? contract.TickSize : template?.TickSize ?? throw new InvalidOperationException($"ProjectX contract {contract.Id} has no tick size.");
        var tickValue = contract.TickValue > 0 ? contract.TickValue : template?.TickValue ?? 0m;
        if (template is not null && (template.TickSize != tickSize || template.TickValue != tickValue))
        {
            Log.TickMismatch(_logger, root, contract.Id, tickSize, tickValue, template.TickSize, template.TickValue);
        }

        return new InstrumentSpec
        {
            Root = root,
            Name = template?.Name ?? (string.IsNullOrWhiteSpace(contract.Description) ? root.ToString() : contract.Description),
            Exchange = template?.Exchange ?? string.Empty,
            ContractId = contract.Name,
            Expiry = ContractMonth(contract.Name, _time.GetUtcNow()) ?? template?.Expiry ?? DateOnly.FromDateTime(_time.GetUtcNow().UtcDateTime),
            TickSize = tickSize,
            TickValue = tickValue,
            PriceDecimals = template is not null && template.TickSize == tickSize ? template.PriceDecimals : InstrumentCatalog.DecimalsFor(tickSize),
            Sector = template?.Sector ?? InstrumentCatalog.OtherSector,
            TpoRowTicks = template is not null && template.TickSize == tickSize ? template.TpoRowTicks : 0,
        };
    }

    /// <summary>The first day of the contract month in a name such as <c>ESZ5</c> or <c>ESZ25</c>, the nearest such year from now.</summary>
    internal static DateOnly? ContractMonth(string? contractName, DateTimeOffset now)
    {
        var match = contractName is null ? Match.Empty : ContractName().Match(contractName);
        if (!match.Success)
        {
            return null;
        }

        var month = "FGHJKMNQUVXZ".IndexOf(match.Groups["month"].Value[0], StringComparison.Ordinal) + 1;
        var digits = match.Groups["year"].Value;
        var modulus = digits.Length == 1 ? 10 : 100;
        var last = int.Parse(digits, System.Globalization.CultureInfo.InvariantCulture);
        var year = now.Year - (now.Year % modulus) + last;
        if (year < now.Year - 1)
        {
            year += modulus;
        }

        return new DateOnly(year, month, 1);
    }

    private async Task<Contract?> Configured(IProjectXApiClient api, InstrumentRoot root, CancellationToken cancellationToken)
    {
        if (!_options.ContractIds.TryGetValue(root.ToString(), out var configured) || string.IsNullOrWhiteSpace(configured))
        {
            return null;
        }

        return await api.GetContractByIdAsync(configured, cancellationToken).ConfigureAwait(false)
            ?? throw new FeedConfigurationException($"ProjectX has no contract {configured} for {root}; check Feed:ProjectX:ContractIds:{root}.");
    }

    [GeneratedRegex("^(?<root>[A-Z0-9]{1,6}?)(?<month>[FGHJKMNQUVXZ])(?<year>[0-9]{1,2})$", RegexOptions.CultureInvariant, 1000)]
    private static partial Regex ContractName();

    public async Task<IReadOnlyList<TradeEvent>> GetTradesAsync(InstrumentSpec instrument, long fromMs, long toMs, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(instrument);
        if (!_gatewayIds.TryGetValue(instrument.Root, out var contractId))
        {
            return [];
        }

        await ThrottleHistoryAsync(cancellationToken).ConfigureAwait(false);
        using var scope = _scopes.CreateScope();
        var api = scope.ServiceProvider.GetRequiredService<IProjectXApiClient>();
        var bars = await api.GetHistoricalBarsAsync(
            contractId,
            DateTimeOffset.FromUnixTimeMilliseconds(fromMs).UtcDateTime,
            DateTimeOffset.FromUnixTimeMilliseconds(toMs).UtcDateTime,
            AggregateBarUnit.Minute,
            unitNumber: 1,
            limit: 20_000,
            live: _options.SearchLive,
            includePartialBar: false,
            cancellationToken).ConfigureAwait(false);
        var sequence = 0L;
        var trades = new List<TradeEvent>();
        foreach (var bar in bars.OrderBy(b => b.Timestamp))
        {
            trades.AddRange(ProjectXEventMapper.FromBar(bar, instrument, ref sequence));
        }

        return trades;
    }

    /// <summary>
    /// Closed one-minute bars for a gap. The partial minute is left out (<c>includePartialBar: false</c>), so the
    /// caller retries until the bar that covers the gap's end is actually in the list (D-33).
    /// </summary>
    public async Task<IReadOnlyList<HistoricalMinuteBar>> GetClosedMinuteBarsAsync(
        InstrumentSpec instrument,
        long fromMs,
        long toMs,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(instrument);
        if (!_gatewayIds.TryGetValue(instrument.Root, out var contractId))
        {
            return [];
        }

        await ThrottleHistoryAsync(cancellationToken).ConfigureAwait(false);
        using var scope = _scopes.CreateScope();
        var api = scope.ServiceProvider.GetRequiredService<IProjectXApiClient>();
        var bars = await api.GetHistoricalBarsAsync(
            contractId,
            DateTimeOffset.FromUnixTimeMilliseconds(fromMs).UtcDateTime,
            DateTimeOffset.FromUnixTimeMilliseconds(toMs).UtcDateTime,
            AggregateBarUnit.Minute,
            unitNumber: 1,
            limit: 20_000,
            live: _options.SearchLive,
            includePartialBar: false,
            cancellationToken).ConfigureAwait(false);
        var closed = new List<HistoricalMinuteBar>();
        foreach (var bar in bars)
        {
            if (ProjectXEventMapper.ToClosedMinute(bar, instrument) is { } minute)
            {
                closed.Add(minute);
            }
        }

        return closed;
    }

    /// <summary>
    /// Spaces history requests at least <c>HistoryMinIntervalMs</c> apart, so warming every product does not run
    /// into the gateway's request rate limit (assumed about 50 per 30 seconds; to confirm live).
    /// </summary>
    private async Task ThrottleHistoryAsync(CancellationToken cancellationToken)
    {
        long slot;
        lock (_historyGate)
        {
            var now = Now();
            slot = Math.Max(now, _nextHistoryMs);
            _nextHistoryMs = slot + Math.Max(0, _options.HistoryMinIntervalMs);
        }

        var wait = slot - Now();
        if (wait > 0)
        {
            await Task.Delay(TimeSpan.FromMilliseconds(wait), _time, cancellationToken).ConfigureAwait(false);
        }
    }

    public async IAsyncEnumerable<MarketEvent> StreamAsync(
        IReadOnlyList<InstrumentSpec> instruments,
        [EnumeratorCancellation] CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(instruments);
        if (_gatewayIds.Count == 0)
        {
            await ResolveAsync(InstrumentSelection.Of([.. instruments.Select(i => i.Root)]), instruments, cancellationToken).ConfigureAwait(false);
        }

        // Each stream run starts its epochs a million above the last, so a restarted stream never reuses an epoch, and
        // so never reuses a trade id the engine's de-duplication still remembers.
        var epochBase = EpochBase(Interlocked.Increment(ref _streamRuns));
        var states = _gatewayIds.ToDictionary(g => g.Value, g => new ContractState(_byGatewayId[g.Value], epochBase), StringComparer.Ordinal);
        var buffer = new MarketIngestBuffer(_ingest, _metrics);
        Pressure = buffer;
        var early = new EarlyCallbacks(_ingest.TradeCapacity, _ingest.DepthLevelsPerContract);
        var sessionConflict = 0;
        var accept = 0;
        void Offer(object item)
        {
            if (item is ConnectionStatusChange change && ProjectXSessionGuard.IsConflict(change.ErrorMessage))
            {
                // Thrown on the reader, not this callback: IngestionService treats it as a clean stop.
                Interlocked.Exchange(ref sessionConflict, 1);
                buffer.Wake();
                return;
            }

            // HandleGatewayTrade, HandleGatewayDepth and HandleGatewayQuote run on the SignalR client's receive
            // loop, which invokes one handler at a time. Submit must return immediately or quotes, depth and
            // disconnects for every contract wait behind it.
            if (Volatile.Read(ref accept) == 0)
            {
                lock (_stateGate)
                {
                    if (Volatile.Read(ref accept) == 0)
                    {
                        early.Add(item, Now());
                        return;
                    }
                }
            }

            Publish(item);
        }

        void Publish(object item)
        {
            HandleResult handled;
            lock (_stateGate)
            {
                handled = Handle(item, states, Now());
            }

            if (handled.Connection is { } change)
            {
                Log.Connection(_logger, change.PreviousState, change.CurrentState, change.ErrorMessage);
            }

            foreach (var marketEvent in handled.Events)
            {
                if (marketEvent is BookResetEvent { Reason: ContractState.IngestOverflowReason } reset)
                {
                    Log.IngestRecovery(_logger, reset.Root, IngestRecoveryKind.Depth);
                    _metrics?.AddRecovery("depth");
                }

                try
                {
                    buffer.Submit(marketEvent, cancellationToken);
                }
                catch (Exception ex) when (ex is OperationCanceledException or ObjectDisposedException)
                {
                    return;
                }
            }
        }

        void OnDepth(object? sender, OrderBookUpdate row) => Offer(row);
        void OnTrade(object? sender, TradeUpdate trade) => Offer(trade);
        void OnQuote(object? sender, PriceUpdate quote) => Offer(quote);
        void OnStatus(object? sender, ConnectionStatusChange change) => Offer(change);
        _socket.OrderBookUpdateReceived += OnDepth;
        _socket.TradeUpdateReceived += OnTrade;
        _socket.PriceUpdateReceived += OnQuote;
        _socket.ConnectionStatusChanged += OnStatus;
        var available = states.Values.Select(s => s.Spec.Root).ToHashSet();
        var limitedLogged = string.Empty;
        try
        {
            await _socket.ConnectMarketHubAsync(cancellationToken).ConfigureAwait(false);
            var wanted = _depth.Wanted(available, out var limited);
            limitedLogged = LogLimited(limited, limitedLogged);
            foreach (var (contractId, state) in states)
            {
                // Market hub only. The user hub is never opened. Trades, and quotes, for every product; depth only
                // for the ones someone watches (REQUIREMENTS.md FR-54).
                await TrySubscribeAsync(contractId, "trades", _socket.SubscribeToTradeUpdatesAsync, cancellationToken).ConfigureAwait(false);
                if (_options.Quotes)
                {
                    await TrySubscribeAsync(contractId, "quotes", _socket.SubscribeToPriceUpdatesAsync, cancellationToken).ConfigureAwait(false);
                }

                var depthOn = wanted.Contains(state.Spec.Root)
                    && await TrySubscribeAsync(contractId, "depth", _socket.SubscribeToOrderBookUpdatesAsync, cancellationToken).ConfigureAwait(false);
                lock (_stateGate)
                {
                    state.DepthSubscribed = depthOn;
                }
            }

            var withDepth = states.Values.Count(s => s.DepthSubscribed);
            Log.Streaming(_logger, states.Count, withDepth);
            var now = Now();
            var opened = new List<MarketEvent>();
            EarlyCallbacks.Held held;
            lock (_stateGate)
            {
                foreach (var state in states.Values)
                {
                    opened.AddRange(state.Connected(now, _options.SnapshotSettleMs));
                }

                if (early.SawDisconnect)
                {
                    foreach (var state in states.Values)
                    {
                        opened.AddRange(state.Disconnected(now));
                    }
                }

                held = early.Take(now);
                Volatile.Write(ref accept, 1);
            }

            foreach (var item in held.Items)
            {
                Publish(item);
            }

            opened.AddRange(buffer.Drain());
            if (held.DroppedDepth > 0)
            {
                _metrics?.AddDepthDiscarded(held.DroppedDepth);
            }

            if (held.DroppedTrades > 0)
            {
                _metrics?.AddDroppedTrades(held.DroppedTrades);
                foreach (var gap in held.TradeGaps)
                {
                    if (!states.TryGetValue(gap.ContractId, out var state))
                    {
                        continue;
                    }

                    Log.IngestRecovery(_logger, state.Spec.Root, IngestRecoveryKind.Trades);
                    _metrics?.AddRecovery("trades");
                    opened.Add(state.TradeGap(now, gap.StartMs, gap.ThroughMs));
                }
            }

            foreach (var e in opened)
            {
                yield return e;
            }

            using var timer = new PeriodicTimer(TimeSpan.FromMilliseconds(250), _time);
            var tick = timer.WaitForNextTickAsync(cancellationToken).AsTask();
            var read = buffer.WaitToReadAsync(cancellationToken).AsTask();
            var depthVersion = _depth.Version;
            while (!cancellationToken.IsCancellationRequested)
            {
                BeforeRead?.Invoke();
                var done = await Task.WhenAny(read, tick).ConfigureAwait(false);
                var ticked = done == tick;
                if (ticked)
                {
                    if (!await tick.ConfigureAwait(false))
                    {
                        break;
                    }

                    tick = timer.WaitForNextTickAsync(cancellationToken).AsTask();
                }
                else
                {
                    if (!await read.ConfigureAwait(false))
                    {
                        break;
                    }

                    buffer.ConsumeWake();
                    read = buffer.WaitToReadAsync(cancellationToken).AsTask();
                }

                if (Volatile.Read(ref sessionConflict) != 0)
                {
                    throw new ProjectXSessionConflictException();
                }

                now = Now();
                foreach (var e in buffer.Drain())
                {
                    yield return e;
                }

                foreach (var recovery in buffer.TakeRecoveries())
                {
                    var state = states.Values.FirstOrDefault(s => s.Spec.Root == recovery.Root);
                    if (state is null)
                    {
                        continue;
                    }

                    Log.IngestRecovery(_logger, recovery.Root, recovery.Kind);
                    if (recovery.Kind == IngestRecoveryKind.Depth)
                    {
                        buffer.DiscardDepth(recovery.Root);
                    }

                    IReadOnlyList<MarketEvent> emitted;
                    lock (_stateGate)
                    {
                        emitted = state.BeginRecovery(now, _options.SnapshotSettleMs, recovery.Kind, recovery.GapStartMs, recovery.GapThroughMs);
                    }

                    foreach (var e in emitted)
                    {
                        yield return e;
                    }
                }

                if (ticked || _depth.Version != depthVersion)
                {
                    // Viewers came or went, or a released product's delay ran out: match the depth subscriptions.
                    depthVersion = _depth.Version;
                    wanted = _depth.Wanted(available, out limited);
                    limitedLogged = LogLimited(limited, limitedLogged);
                    foreach (var (contractId, state) in states)
                    {
                        bool turnOn;
                        lock (_stateGate)
                        {
                            turnOn = wanted.Contains(state.Spec.Root);
                            if (turnOn == state.DepthSubscribed)
                            {
                                continue;
                            }
                        }

                        var changed = turnOn
                            ? await TrySubscribeAsync(contractId, "depth", _socket.SubscribeToOrderBookUpdatesAsync, cancellationToken).ConfigureAwait(false)
                            : await TrySubscribeAsync(contractId, "depth off", _socket.UnsubscribeFromOrderBookUpdatesAsync, cancellationToken).ConfigureAwait(false);
                        if (!changed)
                        {
                            continue;
                        }

                        Log.DepthChanged(_logger, state.Spec.Root, turnOn);
                        IReadOnlyList<MarketEvent> switched;
                        lock (_stateGate)
                        {
                            switched = turnOn ? state.DepthOn(now, _options.SnapshotSettleMs) : state.DepthOff(now);
                        }

                        foreach (var e in switched)
                        {
                            yield return e;
                        }
                    }
                }

                var settled = new List<DepthSnapshotEvent>();
                lock (_stateGate)
                {
                    foreach (var state in states.Values)
                    {
                        if (state.TrySettle(now, _options.LevelsPerSide) is { } snapshot)
                        {
                            settled.Add(snapshot);
                        }
                    }
                }

                foreach (var snapshot in settled)
                {
                    yield return snapshot;
                }
            }
        }
        finally
        {
            _socket.OrderBookUpdateReceived -= OnDepth;
            _socket.TradeUpdateReceived -= OnTrade;
            _socket.PriceUpdateReceived -= OnQuote;
            _socket.ConnectionStatusChanged -= OnStatus;
            buffer.Complete();
            buffer.Dispose();
            Pressure = null;
            try
            {
                await _socket.DisconnectMarketHubAsync(CancellationToken.None).ConfigureAwait(false);
            }
            catch (InvalidOperationException ex)
            {
                Log.DisconnectFailed(_logger, ex);
            }
        }
    }

    /// <summary>
    /// One subscription call; false, logged with the contract and stream, when the gateway refuses it (for example
    /// at a per-connection subscription limit), so one refused product never stops the others.
    /// </summary>
    private async Task<bool> TrySubscribeAsync(
        string contractId,
        string stream,
        Func<string, CancellationToken, Task> call,
        CancellationToken cancellationToken)
    {
        try
        {
            await call(contractId, cancellationToken).ConfigureAwait(false);
            return true;
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            Log.SubscribeFailed(_logger, stream, contractId, ex);
            return false;
        }
    }

    private string LogLimited(IReadOnlyList<InstrumentRoot> limited, string previous)
    {
        var text = string.Join(' ', limited);
        if (text.Length > 0 && !string.Equals(text, previous, StringComparison.Ordinal))
        {
            Log.DepthLimited(_logger, _depth.MaxSubscriptions, text);
        }

        return text;
    }

    private readonly record struct HandleResult(List<MarketEvent> Events, ConnectionStatusChange? Connection);

    private HandleResult Handle(object item, Dictionary<string, ContractState> states, long now)
    {
        var events = new List<MarketEvent>();
        switch (item)
        {
            case OrderBookUpdate row when states.TryGetValue(row.ContractId ?? string.Empty, out var state):
                events.AddRange(state.OnDepth(row, now, _options.SnapshotSettleMs, _ingest.DepthLevelsPerContract));
                break;
            case TradeUpdate trade when states.TryGetValue(trade.ContractId ?? string.Empty, out var state):
                if (state.OnTrade(trade, now) is { } mapped)
                {
                    events.Add(mapped);
                }

                break;
            case PriceUpdate quote when states.TryGetValue(quote.ContractId ?? string.Empty, out var state):
                // A quote has no resting size and is not an execution. It becomes a quote event, never a trade or a depth row.
                if (state.OnQuote(quote, now) is { } top)
                {
                    events.Add(top);
                }

                break;
            case ConnectionStatusChange change:
                // Each status is applied in order. Connecting and Reconnecting are not up, so they stop the
                // settle; the Connected that follows starts a new epoch. Nothing here is remembered past this call.
                foreach (var state in states.Values)
                {
                    events.AddRange(HubIsUp(change.CurrentState)
                        ? state.Connected(now, _options.SnapshotSettleMs)
                        : state.Disconnected(now));
                }

                return new HandleResult(events, change);
            default:
                break;
        }

        return new HandleResult(events, null);
    }

    private long Now() => _time.GetUtcNow().ToUnixTimeMilliseconds();

    /// <summary>Per-contract connection epoch, sequence, settle buffer and tick-rule memory.</summary>
    internal static long EpochBase(long streamRun) => (streamRun - 1) * 1_000_000;

    internal sealed class ContractState(InstrumentSpec spec, long epochBase = 0)
    {
        private readonly SortedDictionary<long, long> _bids = [];
        private readonly SortedDictionary<long, long> _asks = [];
        private long _epoch = epochBase;
        private long _sequence;
        private long? _settleAtMs;
        private int _settleOverflows;
        private bool _connected;
        private long? _lastTradeTicks;
        private BookSide? _lastAggressor;
        private (long? Bid, long? Ask) _lastQuote;

        public InstrumentSpec Spec { get; } = spec;

        public bool Building => _settleAtMs is not null;

        /// <summary>Whether depth is subscribed for this contract (REQUIREMENTS.md FR-54); true until the feed says otherwise.</summary>
        public bool DepthSubscribed { get; set; } = true;

        public IReadOnlyList<MarketEvent> Connected(long now, int settleMs)
        {
            _epoch++;
            _connected = true;
            _lastQuote = default;
            if (!DepthSubscribed)
            {
                return [Status(now, connected: true)];
            }

            StartBuilding(now, settleMs, resubscribe: true);
            return [Status(now, connected: true), Reset(now, BookResetEvent.SubscribedReason)];
        }

        /// <summary>Depth was just subscribed: the book builds from scratch, exactly as after a connect.</summary>
        public IReadOnlyList<MarketEvent> DepthOn(long now, int settleMs)
        {
            DepthSubscribed = true;
            if (!_connected)
            {
                return [];
            }

            StartBuilding(now, settleMs, resubscribe: true);
            return [Status(now, connected: true), Reset(now, BookResetEvent.SubscribedReason)];
        }

        /// <summary>Depth was just unsubscribed: the book becomes unknown on purpose, and trades and quotes go on.</summary>
        public IReadOnlyList<MarketEvent> DepthOff(long now)
        {
            DepthSubscribed = false;
            _settleAtMs = null;
            _bids.Clear();
            _asks.Clear();
            _lastQuote = default;
            return _connected ? [Status(now, connected: true)] : [];
        }

        /// <summary>A gateway quote as top-of-book prices, or null when nothing changed or a price is off the grid.</summary>
        public QuoteEvent? OnQuote(PriceUpdate quote, long now)
        {
            long? bid = quote.BestBid > 0 && Spec.TryToTicks(quote.BestBid, out var b) ? b : null;
            long? ask = quote.BestAsk > 0 && Spec.TryToTicks(quote.BestAsk, out var a) ? a : null;
            if ((bid is null && ask is null) || (bid, ask) == _lastQuote)
            {
                return null;
            }

            _lastQuote = (bid, ask);
            NoteExchange(quote.Timestamp, now);
            return new QuoteEvent
            {
                Root = Spec.Root,
                ContractId = Spec.ContractId,
                SourceTimeMs = ProjectXEventMapper.ToUnixMs(quote.Timestamp, now),
                ReceivedTimeMs = now,
                Epoch = _epoch,
                Sequence = ++_sequence,
                BidTicks = bid,
                AskTicks = ask,
            };
        }

        public IReadOnlyList<MarketEvent> Disconnected(long now)
        {
            if (!_connected)
            {
                return [];
            }

            _connected = false;
            _settleAtMs = null;
            return [Status(now, connected: false)];
        }

        public IReadOnlyList<MarketEvent> OnDepth(OrderBookUpdate row, long now, int settleMs, int maxPendingLevels = 4_096)
        {
            if (!DepthSubscribed)
            {
                // A row still in flight after the unsubscribe.
                return [];
            }

            switch (ProjectXEventMapper.Classify(row.Type))
            {
                case ProjectXEventMapper.DepthAction.Reset:
                    NoteExchange(row.Timestamp, now);
                    StartBuilding(now, settleMs, resubscribe: false);
                    return [Reset(now, "gateway reset")];
                case ProjectXEventMapper.DepthAction.Level when ProjectXEventMapper.Level(row, Spec) is { } level:
                    NoteExchange(row.Timestamp, now);
                    if (Building)
                    {
                        var book = level.Side == BookSide.Bid ? _bids : _asks;
                        if (level.Quantity > 0)
                        {
                            book[level.PriceTicks] = level.Quantity;
                        }
                        else
                        {
                            book.Remove(level.PriceTicks);
                        }

                        // The settle book is trimmed to LevelsPerSide when it is emitted. Distinct prices still have
                        // to be capped, or one burst fills the process before the window ends (REQUIREMENTS.md NFR-4).
                        if (level.Quantity > 0 && _bids.Count + _asks.Count > maxPendingLevels)
                        {
                            _settleOverflows++;
                            StartBuilding(now, SettleDelay(settleMs), resubscribe: false);
                            return [Reset(now, IngestOverflowReason)];
                        }

                        return [];
                    }

                    return
                    [
                        new DepthUpdateEvent
                        {
                            Root = Spec.Root,
                            ContractId = Spec.ContractId,
                            SourceTimeMs = ProjectXEventMapper.ToUnixMs(row.Timestamp, now),
                            ReceivedTimeMs = now,
                            Epoch = _epoch,
                            Sequence = ++_sequence,
                            Side = level.Side,
                            PriceTicks = level.PriceTicks,
                            Quantity = level.Quantity,
                        },
                    ];
                default:
                    return [];
            }
        }

        public TradeEvent? OnTrade(TradeUpdate trade, long now)
        {
            NoteExchange(trade.Timestamp, now);
            var mapped = ProjectXEventMapper.Trade(trade, Spec, now, _epoch, ++_sequence, _lastTradeTicks, _lastAggressor);
            if (mapped is not null)
            {
                _lastTradeTicks = mapped.PriceTicks;
                _lastAggressor = mapped.Aggressor;
            }

            return mapped;
        }

        /// <summary>The reset reason when the ingest cap, not the gateway, invalidated the book.</summary>
        public const string IngestOverflowReason = "ingest overflow";

        /// <summary>
        /// The ingest buffer could not keep this contract correct. Depth overflow restarts the settle window, so
        /// the book is unknown until the snapshot. A dropped trade is reported as a gap and the feed stays
        /// connected; the engine marks the contract DEGRADED rather than rebuilding the trades (D-32).
        /// </summary>
        public IReadOnlyList<MarketEvent> BeginRecovery(long now, int settleMs, IngestRecoveryKind kind, long gapStartMs = 0, long gapThroughMs = 0)
        {
            if (kind == IngestRecoveryKind.Trades)
            {
                return [TradeGap(now, gapStartMs, gapThroughMs)];
            }

            if (!DepthSubscribed || !_connected)
            {
                return [];
            }

            _settleOverflows++;
            StartBuilding(now, SettleDelay(settleMs), resubscribe: false);
            return [Reset(now, IngestOverflowReason)];
        }

        /// <summary>Tells ingestion the first dropped trade's exchange time. Does not change the feed's connection.</summary>
        public TradeGapEvent TradeGap(long now, long gapStartMs, long gapThroughMs = 0) => new()
        {
            Root = Spec.Root,
            ContractId = Spec.ContractId,
            SourceTimeMs = gapStartMs,
            ReceivedTimeMs = now,
            Epoch = _epoch,
            Sequence = ++_sequence,
            GapStartMs = gapStartMs,
            GapThroughMs = gapThroughMs > gapStartMs ? gapThroughMs : gapStartMs,
            Provenance = FeedProvenance.Live,
            DepthSubscribed = DepthSubscribed,
        };

        /// <summary>Emits the collected book once the settle window has passed.</summary>
        public DepthSnapshotEvent? TrySettle(long now, int levelsPerSide)
        {
            if (_settleAtMs is not { } at || now < at || !_connected)
            {
                return null;
            }

            _settleAtMs = null;
            _settleOverflows = 0;
            var bestAsk = _asks.Count > 0 ? _asks.Keys.First() : long.MaxValue;
            var bids = _bids.Reverse().Where(l => l.Key < bestAsk).Take(levelsPerSide).Select(l => new BookLevel(l.Key, l.Value)).ToList();
            var bestBid = bids.Count > 0 ? bids[0].PriceTicks : long.MinValue;
            var asks = _asks.Where(l => l.Key > bestBid).Take(levelsPerSide).Select(l => new BookLevel(l.Key, l.Value)).ToList();
            return new DepthSnapshotEvent
            {
                Root = Spec.Root,
                ContractId = Spec.ContractId,
                SourceTimeMs = now,
                ReceivedTimeMs = now,
                Epoch = _epoch,
                Sequence = ++_sequence,
                Bids = bids,
                Asks = asks,
                LevelsPerSide = levelsPerSide,
                Resubscribe = _resubscribeSettle,
                GatewayTimeMs = _exchangeTimeMs,
            };
        }

        private bool _resubscribeSettle;

        /// <summary>Latest gateway timestamp that is not past the receive clock by more than the engine allows (D-32).</summary>
        private long? _exchangeTimeMs;

        private void NoteExchange(DateTime timestamp, long now)
        {
            if (timestamp == default)
            {
                return;
            }

            var ms = ProjectXEventMapper.ToUnixMs(timestamp, 0);
            if (ms > now + InstrumentEngine.MaxClockAheadMs)
            {
                return;
            }

            if (_exchangeTimeMs is null || ms > _exchangeTimeMs)
            {
                _exchangeTimeMs = ms;
            }
        }

        private void StartBuilding(long now, int settleMs, bool resubscribe)
        {
            _bids.Clear();
            _asks.Clear();
            _settleAtMs = now + settleMs;
            _resubscribeSettle = resubscribe;
        }

        /// <summary>Grows the settle window after repeated overflows so a book that cannot fit does not restart every window.</summary>
        private int SettleDelay(int settleMs)
        {
            var scaled = settleMs * (1 << Math.Min(Math.Max(_settleOverflows - 1, 0), 4));
            return Math.Min(30_000, Math.Max(settleMs, scaled));
        }

        /// <summary>A status for the engine that does not change this feed's own connection flag.</summary>
        private FeedStatusEvent EngineStatus(long now, bool connected) => new()
        {
            Root = Spec.Root,
            ContractId = Spec.ContractId,
            SourceTimeMs = now,
            ReceivedTimeMs = now,
            Epoch = _epoch,
            Sequence = ++_sequence,
            Connected = connected,
            Provenance = FeedProvenance.Live,
            DepthSubscribed = DepthSubscribed,
            GatewayTimeMs = _exchangeTimeMs,
        };

        private FeedStatusEvent Status(long now, bool connected) => new()
        {
            Root = Spec.Root,
            ContractId = Spec.ContractId,
            SourceTimeMs = now,
            ReceivedTimeMs = now,
            Epoch = _epoch,
            Sequence = ++_sequence,
            Connected = connected,
            Provenance = FeedProvenance.Live,
            DepthSubscribed = DepthSubscribed,
            GatewayTimeMs = _exchangeTimeMs,
        };

        private BookResetEvent Reset(long now, string reason) => new()
        {
            Root = Spec.Root,
            ContractId = Spec.ContractId,
            SourceTimeMs = now,
            ReceivedTimeMs = now,
            Epoch = _epoch,
            Sequence = ++_sequence,
            Reason = reason,
        };
    }

    /// <summary>
    /// The hub is delivering only in <see cref="ConnectionState.Connected"/>.
    /// <c>ConnectMarketHubAsync</c> reports <see cref="ConnectionState.Connecting"/> before <c>StartAsync</c>,
    /// and SignalR reports <see cref="ConnectionState.Reconnecting"/> only after a connection has dropped.
    /// </summary>
    private static bool HubIsUp(ConnectionState state) => state switch
    {
        ConnectionState.Connected => true,
        ConnectionState.Connecting => false,
        ConnectionState.Reconnecting => false,
        ConnectionState.Disconnected => false,
        ConnectionState.Failed => false,
        // The client enum can hold a value it has not named. That socket is not up.
        _ => false,
    };

    /// <summary>
    /// Events that arrive before the stream has emitted its own connect status. Trades and depth rows past the
    /// per-contract cap are counted and dropped. Quotes keep the latest per contract. The latest hub state is
    /// remembered and, when that state is not up, emitted by the stream itself after its own connect
    /// (ARCHITECTURE.md D-15, D-32). An earlier <see cref="ConnectionState.Connecting"/> or
    /// <see cref="ConnectionState.Reconnecting"/> does not stay a disconnect once
    /// <see cref="ConnectionState.Connected"/> has followed. Depth and quotes buffered before a drop are discarded,
    /// so they are not mixed into the book settled after the following <see cref="ConnectionState.Connected"/>.
    /// </summary>
    private sealed class EarlyCallbacks(int tradeCapacity, int depthCapacity)
    {
        private readonly List<object> _items = [];
        private readonly Dictionary<string, int> _tradeCounts = new(StringComparer.Ordinal);
        private readonly Dictionary<string, int> _depthCounts = new(StringComparer.Ordinal);
        private readonly Dictionary<string, long> _gaps = new(StringComparer.Ordinal);
        private readonly Dictionary<string, long> _gapThrough = new(StringComparer.Ordinal);
        private readonly Dictionary<string, PriceUpdate> _quotes = new(StringComparer.Ordinal);
        private ConnectionState? _hubState;
        private bool _sawUp;

        /// <summary>True when a hub status arrived and the latest one is not <see cref="ConnectionState.Connected"/>.</summary>
        public bool SawDisconnect => _hubState is { } state && !HubIsUp(state);

        public long DroppedTrades { get; private set; }

        public long DroppedDepth { get; private set; }

        public void Add(object item, long nowMs)
        {
            switch (item)
            {
                case ConnectionStatusChange change:
                    var up = HubIsUp(change.CurrentState);
                    if (_hubState is { } prior && HubIsUp(prior) && !up)
                    {
                        // The book from before this drop must not settle with the rows that follow the reconnect.
                        _items.RemoveAll(static item => item is OrderBookUpdate);
                        _depthCounts.Clear();
                        _quotes.Clear();
                    }

                    if (up)
                    {
                        _sawUp = true;
                    }

                    _hubState = change.CurrentState;
                    return;
                case TradeUpdate trade:
                    var tradeId = trade.ContractId ?? string.Empty;
                    var trades = _tradeCounts.GetValueOrDefault(tradeId);
                    if (trades >= tradeCapacity)
                    {
                        DroppedTrades++;
                        // Clamp at arrival. A later Take would treat a far-ahead stamp as a normal clock (D-32).
                        var at = Bound(ProjectXEventMapper.ToUnixMs(trade.Timestamp, 0), nowMs);
                        _gaps.TryAdd(tradeId, at);
                        if (!_gapThrough.TryGetValue(tradeId, out var through) || at > through)
                        {
                            _gapThrough[tradeId] = at;
                        }

                        return;
                    }

                    _tradeCounts[tradeId] = trades + 1;
                    _items.Add(trade);
                    return;
                case PriceUpdate quote:
                    if (IgnoreBookWhileDown())
                    {
                        return;
                    }

                    _quotes[quote.ContractId ?? string.Empty] = quote;
                    return;
                case OrderBookUpdate row:
                    if (IgnoreBookWhileDown())
                    {
                        return;
                    }

                    var depthId = row.ContractId ?? string.Empty;
                    var depth = _depthCounts.GetValueOrDefault(depthId);
                    if (depth >= depthCapacity)
                    {
                        DroppedDepth++;
                        return;
                    }

                    _depthCounts[depthId] = depth + 1;
                    _items.Add(row);
                    return;
                default:
                    return;
            }
        }

        public Held Take(long nowMs)
        {
            var items = new List<object>(_items.Count + _quotes.Count);
            items.AddRange(_items);
            items.AddRange(_quotes.Values);
            var gaps = new List<EarlyGap>(_gaps.Count);
            foreach (var (contractId, start) in _gaps)
            {
                var from = Bound(start, nowMs);
                var through = Bound(_gapThrough.GetValueOrDefault(contractId), nowMs);
                if (through < from)
                {
                    through = from;
                }

                gaps.Add(new EarlyGap(contractId, from, through));
            }

            return new Held(items, DroppedTrades, DroppedDepth, gaps);
        }

        /// <summary>Depth and quotes that arrive after a drop, and before the hub is up again, are not the next book.</summary>
        private bool IgnoreBookWhileDown() => _sawUp && _hubState is { } state && !HubIsUp(state);

        /// <summary>An unset stamp is the receive time. One more than a minute ahead is not a clock (D-32).</summary>
        private static long Bound(long stampMs, long nowMs) =>
            stampMs == 0 ? nowMs : InstrumentEngine.AcceptedStamp(stampMs, nowMs);

        public readonly record struct EarlyGap(string ContractId, long StartMs, long ThroughMs);

        public readonly record struct Held(List<object> Items, long DroppedTrades, long DroppedDepth, List<EarlyGap> TradeGaps);
    }

    private static partial class Log
    {
        [LoggerMessage(Level = LogLevel.Information, Message = "ProjectX contract for {Root}: {ContractId} ({Name})")]
        public static partial void Resolved(ILogger logger, InstrumentRoot root, string contractId, string name);

        [LoggerMessage(Level = LogLevel.Information, Message = "ProjectX market hub {Previous} -> {Current} {Error}")]
        public static partial void Connection(ILogger logger, ConnectionState previous, ConnectionState current, string? error);

        [LoggerMessage(Level = LogLevel.Warning, Message = "ProjectX lists {Count} products, more than Feed:ProjectX:MaxContracts ({Max}); not streaming {Dropped}")]
        public static partial void ContractsCapped(ILogger logger, int count, int max, string dropped);

        [LoggerMessage(Level = LogLevel.Warning, Message = "ProjectX contract {ContractId} for {Root}: gateway tick {TickSize} worth {TickValue}, catalog {CatalogTickSize} worth {CatalogTickValue}; using the gateway's")]
        public static partial void TickMismatch(ILogger logger, InstrumentRoot root, string contractId, decimal tickSize, decimal tickValue, decimal catalogTickSize, decimal catalogTickValue);

        [LoggerMessage(Level = LogLevel.Information, Message = "ProjectX streaming {Count} products, {Depth} with depth")]
        public static partial void Streaming(ILogger logger, int count, int depth);

        [LoggerMessage(Level = LogLevel.Information, Message = "ProjectX depth for {Root}: {On}")]
        public static partial void DepthChanged(ILogger logger, InstrumentRoot root, bool on);

        [LoggerMessage(Level = LogLevel.Warning, Message = "Depth is limited to {Max} products (Feed:Depth:MaxSubscriptions); trades and quotes only for {Roots}")]
        public static partial void DepthLimited(ILogger logger, int max, string roots);

        [LoggerMessage(Level = LogLevel.Error, Message = "ProjectX refused the {Stream} subscription for {ContractId}; that product streams without it")]
        public static partial void SubscribeFailed(ILogger logger, string stream, string contractId, Exception exception);

        [LoggerMessage(Level = LogLevel.Warning, Message = "ProjectX market hub disconnect failed")]
        public static partial void DisconnectFailed(ILogger logger, Exception exception);

        [LoggerMessage(Level = LogLevel.Warning, Message = "Ingest buffer overflow for {Root} ({Kind}); the contract leaves LIVE until it recovers")]
        public static partial void IngestRecovery(ILogger logger, InstrumentRoot root, IngestRecoveryKind kind);
    }
}
