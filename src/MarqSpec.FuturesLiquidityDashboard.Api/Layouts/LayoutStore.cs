using System.Text.Json;
using MarqSpec.FuturesLiquidityDashboard.Core.Instruments;
using Microsoft.Extensions.Options;

namespace MarqSpec.FuturesLiquidityDashboard.Api.Layouts;

/// <summary>
/// Layouts by user name, kept in one JSON file so a viewer's layout and simulated positions survive an API restart
/// (REQUIREMENTS.md FR-9, FR-72; ARCHITECTURE.md D-18). Market state is not kept here and is rebuilt from warmup.
/// The file is read on first use. A missing, unreadable or corrupt file is an empty store and a logged warning, and an
/// entry the API would not accept as a PUT is dropped with a warning. A file that was not read in full is renamed to
/// <c>&lt;name&gt;.corrupt-&lt;UTC time&gt;</c> before the next write, so nothing in it is overwritten. Each applied save
/// rewrites the whole file through a temp file beside it and one rename, so the file is the previous save or this one,
/// never part of either. A save the file cannot take is not applied: memory keeps the previous revision, and the result
/// says the store failed. A blank <see cref="LayoutStoreOptions.StorePath"/> keeps layouts in memory only.
/// A save applies only when the caller's revision is the one stored, so a stale write cannot replace a later one.
/// One API replica owns the file.
/// </summary>
public sealed partial class LayoutStore : IDisposable
{
    /// <summary>The file layout this build reads and writes. Any other version is read as corrupt.</summary>
    internal const int FileVersion = 1;

    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web) { WriteIndented = true };

    private readonly SemaphoreSlim _gate = new(1, 1);
    private readonly Dictionary<string, LayoutDocument> _layouts = new(StringComparer.Ordinal);
    private readonly ILayoutFileSystem _files;
    private readonly TimeProvider _time;
    private readonly ILogger<LayoutStore> _logger;
    private readonly bool _persistent;
    private readonly string _path;
    private readonly string _tempPath;
    private bool _loaded;
    private bool _moveAside;

    public LayoutStore(ILayoutFileSystem files, IOptions<LayoutStoreOptions> options, TimeProvider time, ILogger<LayoutStore> logger)
    {
        ArgumentNullException.ThrowIfNull(files);
        ArgumentNullException.ThrowIfNull(options);
        ArgumentNullException.ThrowIfNull(time);
        ArgumentNullException.ThrowIfNull(logger);
        _files = files;
        _time = time;
        _logger = logger;
        _persistent = options.Value.IsPersistent;
        _path = options.Value.StorePath;
        _tempPath = _path + ".tmp";
    }

    /// <summary>The caller's layout, or an unsaved default (revision 0) when none is stored.</summary>
    public async Task<LayoutDocument> GetAsync(string user, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(user);
        await _gate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            await EnsureLoadedAsync().ConfigureAwait(false);
            return _layouts.TryGetValue(user, out var layout) ? layout : Unsaved();
        }
        finally
        {
            _gate.Release();
        }
    }

    /// <summary>
    /// Stores <paramref name="layout"/> when <paramref name="expectedRevision"/> equals the revision held for
    /// <paramref name="user"/> (0 when nothing is saved). The stored revision becomes that value plus one, and the file
    /// is rewritten. Any other revision stores and writes nothing and returns the document still held. When the file
    /// cannot be written (or a corrupt one moved aside), the save is undone in memory as well, the error is logged, and the
    /// result has <see cref="LayoutSaveResult.StoreFailed"/> set with the document still held.
    /// </summary>
    public async Task<LayoutSaveResult> SaveAsync(string user, LayoutSettings layout, long expectedRevision, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(user);
        ArgumentNullException.ThrowIfNull(layout);
        await _gate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            await EnsureLoadedAsync().ConfigureAwait(false);
            var current = _layouts.TryGetValue(user, out var held) ? held : Unsaved();
            if (expectedRevision != current.Revision)
            {
                return new LayoutSaveResult(false, current);
            }

            var stored = new LayoutDocument
            {
                Saved = true,
                Revision = checked(current.Revision + 1),
                Layout = layout,
            };
            _layouts[user] = stored;
            if (!await PersistAsync().ConfigureAwait(false))
            {
                // Never acknowledge what a restart would lose: the client keeps its copy pending and sends it again.
                if (held is null)
                {
                    _layouts.Remove(user);
                }
                else
                {
                    _layouts[user] = held;
                }

                return new LayoutSaveResult(false, current, StoreFailed: true);
            }

            return new LayoutSaveResult(true, stored);
        }
        finally
        {
            _gate.Release();
        }
    }

    // Not cancellable: a load or write abandoned halfway would leave memory and the file telling different stories.
    private async Task EnsureLoadedAsync()
    {
        if (_loaded)
        {
            return;
        }

        _loaded = true;
        if (!_persistent)
        {
            return;
        }

        string? text;
        try
        {
            text = await _files.ReadAsync(_path, CancellationToken.None).ConfigureAwait(false);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            LogUnreadable(_logger, _path, ex.GetType().Name);
            _moveAside = true;
            return;
        }

        if (text is null)
        {
            LogMissing(_logger, _path);
            return;
        }

        LayoutFile? file;
        try
        {
            file = JsonSerializer.Deserialize<LayoutFile>(text, Json);
        }
        catch (JsonException ex)
        {
            LogCorrupt(_logger, _path, $"not valid JSON at {ex.Path ?? "$"}, line {ex.LineNumber}");
            _moveAside = true;
            return;
        }

        if (file is null || file.Version != FileVersion || file.Layouts is null)
        {
            LogCorrupt(_logger, _path, $"expected version {FileVersion} with a layouts map");
            _moveAside = true;
            return;
        }

        var dropped = 0;
        foreach (var (user, entry) in file.Layouts)
        {
            if (entry is not null && IsAcceptable(entry))
            {
                _layouts[user] = new LayoutDocument { Saved = true, Revision = entry.Revision, Layout = entry.Layout! };
            }
            else
            {
                dropped++;
            }
        }

        if (dropped > 0)
        {
            LogDropped(_logger, _path, dropped);
            _moveAside = true;
        }
    }

    /// <summary>Only what PUT /api/layouts/me would store: a positive revision and a layout that validates.</summary>
    private static bool IsAcceptable(StoredLayout entry) =>
        entry.Revision >= 1
        && entry.Layout is { Watchlist: not null, Panes: not null, Signals: not null } layout
        && InstrumentCatalog.TryParse(layout.Instrument, out _)
        && layout.Validate().Count == 0;

    /// <summary>Writes every layout to the file. False when it could not, and the file keeps the previous save.</summary>
    private async Task<bool> PersistAsync()
    {
        if (!_persistent)
        {
            return true;
        }

        if (!TryMoveAside())
        {
            return false;
        }

        var file = new LayoutFile
        {
            Version = FileVersion,
            Layouts = _layouts.ToDictionary(
                pair => pair.Key,
                pair => (StoredLayout?)new StoredLayout { Revision = pair.Value.Revision, Layout = pair.Value.Layout },
                StringComparer.Ordinal),
        };
        try
        {
            await _files.WriteAsync(_tempPath, JsonSerializer.Serialize(file, Json), CancellationToken.None).ConfigureAwait(false);
            _files.Replace(_tempPath, _path);
            return true;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            LogWriteFailed(_logger, _path, ex.GetType().Name);
            return false;
        }
    }

    public void Dispose() => _gate.Dispose();

    /// <summary>Renames a file that was not read in full, once, before it is first written over. False when it must stay.</summary>
    private bool TryMoveAside()
    {
        if (!_moveAside)
        {
            return true;
        }

        var aside = $"{_path}.corrupt-{_time.GetUtcNow():yyyyMMdd'T'HHmmss'Z'}";
        try
        {
            _files.Move(_path, aside);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            // Never overwrite what could not be kept: this save is refused, and the next one tries again.
            LogMoveAsideFailed(_logger, _path, ex.GetType().Name);
            return false;
        }

        _moveAside = false;
        LogMovedAside(_logger, _path, aside);
        return true;
    }

    private static LayoutDocument Unsaved() => new() { Saved = false, Revision = 0, Layout = new LayoutSettings() };

    [LoggerMessage(Level = LogLevel.Warning, Message = "Layout store {Path} does not exist; starting with no saved layouts. The first save creates it")]
    private static partial void LogMissing(ILogger logger, string path);

    [LoggerMessage(Level = LogLevel.Warning, Message = "Layout store {Path} could not be read ({ExceptionType}); starting with no saved layouts. The next save moves it aside")]
    private static partial void LogUnreadable(ILogger logger, string path, string exceptionType);

    [LoggerMessage(Level = LogLevel.Warning, Message = "Layout store {Path} is corrupt ({Reason}); starting with no saved layouts. The next save moves it aside")]
    private static partial void LogCorrupt(ILogger logger, string path, string reason);

    [LoggerMessage(Level = LogLevel.Warning, Message = "Layout store {Path}: {Count} saved layout(s) the API would not accept were dropped")]
    private static partial void LogDropped(ILogger logger, string path, int count);

    [LoggerMessage(Level = LogLevel.Warning, Message = "Layout store {Path} moved aside to {MovedTo} before the first save over it")]
    private static partial void LogMovedAside(ILogger logger, string path, string movedTo);

    [LoggerMessage(Level = LogLevel.Error, Message = "Layout store {Path} could not be moved aside ({ExceptionType}); it is left as it is, and saves are refused until it can be")]
    private static partial void LogMoveAsideFailed(ILogger logger, string path, string exceptionType);

    [LoggerMessage(Level = LogLevel.Error, Message = "Layout store {Path} could not be written ({ExceptionType}); the save was refused, and the file keeps the previous save")]
    private static partial void LogWriteFailed(ILogger logger, string path, string exceptionType);

    /// <summary>The file: a version and each user's layout with its revision. Nothing else is written.</summary>
    private sealed record LayoutFile
    {
        public int Version { get; init; }

        public Dictionary<string, StoredLayout?>? Layouts { get; init; }
    }

    private sealed record StoredLayout
    {
        public long Revision { get; init; }

        public LayoutSettings? Layout { get; init; }
    }
}
