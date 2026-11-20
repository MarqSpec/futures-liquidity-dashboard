namespace MarqSpec.FuturesLiquidityDashboard.IntegrationTests;

/// <summary>A fresh directory under the system temp folder, deleted with everything in it on dispose.</summary>
public sealed class TempDirectory : IDisposable
{
    public TempDirectory()
    {
        Directory.CreateDirectory(FullPath);
    }

    /// <summary>The directory's absolute path; outside the repository, so no test writes into the content root.</summary>
    public string FullPath { get; } = Path.Combine(Path.GetTempPath(), "fld-it-" + Guid.NewGuid().ToString("N"));

    /// <summary>A path inside the directory.</summary>
    public string File(params string[] parts) => Path.Combine([FullPath, .. parts]);

    public void Dispose()
    {
        if (Directory.Exists(FullPath))
        {
            Directory.Delete(FullPath, recursive: true);
        }
    }
}
