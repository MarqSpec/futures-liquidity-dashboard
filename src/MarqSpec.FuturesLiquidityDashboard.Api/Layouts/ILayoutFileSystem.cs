namespace MarqSpec.FuturesLiquidityDashboard.Api.Layouts;

/// <summary>
/// The file operations the layout store needs, and no more, so the unit tier can fake the disk
/// (CONVENTIONS.md §8.1). <see cref="PhysicalLayoutFileSystem"/> is the real one.
/// </summary>
public interface ILayoutFileSystem
{
    /// <summary>The file's text, or null when the file does not exist.</summary>
    Task<string?> ReadAsync(string path, CancellationToken cancellationToken);

    /// <summary>Writes <paramref name="contents"/> to <paramref name="path"/>, creating its directory, and flushes it to disk.</summary>
    Task WriteAsync(string path, string contents, CancellationToken cancellationToken);

    /// <summary>Moves <paramref name="source"/> over <paramref name="destination"/> in one rename, replacing it.</summary>
    void Replace(string source, string destination);

    /// <summary>Renames <paramref name="source"/> to <paramref name="destination"/>, failing if the destination exists.</summary>
    void Move(string source, string destination);
}

/// <summary>
/// <see cref="ILayoutFileSystem"/> on the local disk. <see cref="Replace"/> is a rename on the same volume, so a reader
/// sees the old file or the new one, never part of either.
/// </summary>
public sealed class PhysicalLayoutFileSystem : ILayoutFileSystem
{
    public async Task<string?> ReadAsync(string path, CancellationToken cancellationToken)
    {
        try
        {
            return await File.ReadAllTextAsync(path, cancellationToken).ConfigureAwait(false);
        }
        catch (Exception ex) when (ex is FileNotFoundException or DirectoryNotFoundException)
        {
            return null;
        }
    }

    public async Task WriteAsync(string path, string contents, CancellationToken cancellationToken)
    {
        if (Path.GetDirectoryName(path) is { Length: > 0 } directory)
        {
            Directory.CreateDirectory(directory);
        }

        var stream = new FileStream(path, FileMode.Create, FileAccess.Write, FileShare.None, 4096, useAsync: true);
        await using (stream.ConfigureAwait(false))
        {
            await stream.WriteAsync(System.Text.Encoding.UTF8.GetBytes(contents), cancellationToken).ConfigureAwait(false);
            // On disk before the rename, so a crash cannot leave the new name pointing at unwritten data.
            stream.Flush(flushToDisk: true);
        }
    }

    public void Replace(string source, string destination) => File.Move(source, destination, overwrite: true);

    public void Move(string source, string destination) => File.Move(source, destination, overwrite: false);
}
