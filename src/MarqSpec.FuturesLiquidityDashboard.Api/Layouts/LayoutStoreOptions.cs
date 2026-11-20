namespace MarqSpec.FuturesLiquidityDashboard.Api.Layouts;

/// <summary>
/// Where saved layouts are kept across restarts (<c>Layouts:*</c>; REQUIREMENTS.md FR-9, FR-72; ARCHITECTURE.md D-18).
/// One file for the one API replica. The container sets <c>/data/layouts.json</c>, on the volume mounted at <c>/data</c>.
/// A blank path keeps layouts in memory only, as the test hosts do.
/// </summary>
public sealed class LayoutStoreOptions
{
    public const string Section = "Layouts";

    public const string DefaultStorePath = "data/layouts.json";

    /// <summary>The store file. A relative path is taken from the content root; a blank one keeps layouts in memory only.</summary>
    public string StorePath { get; set; } = DefaultStorePath;

    /// <summary>False when <see cref="StorePath"/> is blank: nothing is read or written, and a restart forgets every layout.</summary>
    public bool IsPersistent => !string.IsNullOrWhiteSpace(StorePath);

    /// <summary>The reasons these settings cannot start. Empty when valid.</summary>
    public IReadOnlyList<string> Validate() =>
        IsPersistent && (StorePath.EndsWith('/') || StorePath.EndsWith('\\'))
            ? ["Layouts:StorePath must name a file, such as data/layouts.json, or be blank to keep layouts in memory only."]
            : [];

    /// <summary><see cref="StorePath"/> as an absolute path, a relative one taken from <paramref name="contentRoot"/>.</summary>
    public string ResolvePath(string contentRoot) => Path.GetFullPath(StorePath, contentRoot);
}
