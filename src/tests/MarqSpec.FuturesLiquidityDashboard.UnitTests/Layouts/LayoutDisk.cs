using MarqSpec.FuturesLiquidityDashboard.Api.Layouts;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using Microsoft.Extensions.Time.Testing;

namespace MarqSpec.FuturesLiquidityDashboard.UnitTests.Layouts;

/// <summary>
/// A faked <see cref="ILayoutFileSystem"/> whose files live in a dictionary, so a second store (or a second host) reading
/// the same disk is a restart with no file I/O (CONVENTIONS.md §8.1).
/// </summary>
internal sealed class LayoutDisk
{
    public const string StorePath = "/data/layouts.json";

    public LayoutDisk()
    {
        FileSystem = A.Fake<ILayoutFileSystem>();
        A.CallTo(() => FileSystem.ReadAsync(A<string>._, A<CancellationToken>._))
            .ReturnsLazily((string path, CancellationToken _) =>
            {
                lock (Files)
                {
                    return Task.FromResult(Files.TryGetValue(path, out var text) ? text : null);
                }
            });
        A.CallTo(() => FileSystem.WriteAsync(A<string>._, A<string>._, A<CancellationToken>._))
            .ReturnsLazily((string path, string contents, CancellationToken _) =>
            {
                lock (Files)
                {
                    Files[path] = contents;
                }

                return Task.CompletedTask;
            });
        A.CallTo(() => FileSystem.Replace(A<string>._, A<string>._))
            .Invokes((string source, string destination) =>
            {
                lock (Files)
                {
                    Files[destination] = Files[source];
                    Files.Remove(source);
                }
            });
        A.CallTo(() => FileSystem.Move(A<string>._, A<string>._))
            .Invokes((string source, string destination) =>
            {
                lock (Files)
                {
                    Files.Add(destination, Files[source]);
                    Files.Remove(source);
                }
            });
        A.CallTo(() => Logger.IsEnabled(A<LogLevel>._)).Returns(true);
    }

    /// <summary>Path to text. Only the store's own file is here unless a test puts one in.</summary>
    public Dictionary<string, string> Files { get; } = new(StringComparer.Ordinal);

    public ILayoutFileSystem FileSystem { get; }

    public ILogger<LayoutStore> Logger { get; } = A.Fake<ILogger<LayoutStore>>();

    /// <summary>The clock a corrupt file's moved-aside name is stamped from.</summary>
    public FakeTimeProvider Clock { get; } = new(new DateTimeOffset(2026, 11, 19, 14, 30, 5, TimeSpan.Zero));

    /// <summary>The store file's text, or null when nothing has been written there.</summary>
    public string? Stored
    {
        get
        {
            lock (Files)
            {
                return Files.GetValueOrDefault(StorePath);
            }
        }
    }

    /// <summary>The warnings the stores on this disk logged.</summary>
    public int Warnings => Fake.GetCalls(Logger).Count(call => call.Method.Name == nameof(ILogger.Log) && call.GetArgument<LogLevel>(0) == LogLevel.Warning);

    /// <summary>The errors the stores on this disk logged.</summary>
    public int Errors => Fake.GetCalls(Logger).Count(call => call.Method.Name == nameof(ILogger.Log) && call.GetArgument<LogLevel>(0) == LogLevel.Error);

    /// <summary>A store over this disk, as a process start makes one.</summary>
    public LayoutStore Store() => Store(StorePath);

    /// <summary>A store over this disk with <paramref name="storePath"/>; a blank path keeps layouts in memory only.</summary>
    public LayoutStore Store(string storePath) => new(FileSystem, Options.Create(new LayoutStoreOptions { StorePath = storePath }), Clock, Logger);

    /// <summary>A store over a fresh, empty disk.</summary>
    public static LayoutStore NewStore() => new LayoutDisk().Store();
}
