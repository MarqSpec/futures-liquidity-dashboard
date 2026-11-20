namespace MarqSpec.FuturesLiquidityDashboard.Api.Feedback;

// reference: CONVENTIONS.md §8.1 (no file I/O in the unit tier: the store reaches the disk only through this seam)

/// <summary>The three file operations the budget store needs, so the unit tier can fake them.</summary>
public interface IFeedbackBudgetFiles
{
    /// <summary>The file's text, or null when it does not exist. Throws <see cref="IOException"/> when it cannot be read.</summary>
    string? Read(string path);

    /// <summary>Writes the text, creating the directory when needed.</summary>
    void Write(string path, string content);

    /// <summary>Renames a file, replacing the destination when <paramref name="overwrite"/> is true.</summary>
    void Move(string source, string destination, bool overwrite);
}

/// <summary>The real disk.</summary>
public sealed class PhysicalFeedbackBudgetFiles : IFeedbackBudgetFiles
{
    public string? Read(string path) => File.Exists(path) ? File.ReadAllText(path) : null;

    public void Write(string path, string content)
    {
        var directory = Path.GetDirectoryName(path);
        if (!string.IsNullOrEmpty(directory))
        {
            Directory.CreateDirectory(directory);
        }

        File.WriteAllText(path, content);
    }

    public void Move(string source, string destination, bool overwrite) => File.Move(source, destination, overwrite);
}
