using MarqSpec.FuturesLiquidityDashboard.Api.Layouts;

namespace MarqSpec.FuturesLiquidityDashboard.IntegrationTests;

// The unit tier fakes this seam (CONVENTIONS.md §8.1), so these are the only tests of the real disk under it.
[Trait("Deployment", "None")]
public sealed class PhysicalLayoutFileSystemTests : IDisposable
{
    // Non-ASCII on purpose: the adapter writes UTF-8 bytes and must read the same text back.
    private const string Layouts = """{"version":1,"layouts":{"synthetic-viewer":{"name":"Ünïcode desk — MES"}}}""";

    private readonly TempDirectory _dir = new();
    private readonly PhysicalLayoutFileSystem _sut = new();

    public void Dispose() => _dir.Dispose();

    [Fact]
    public async Task ReadAsync_ShouldReturnNull_WhenTheFileDoesNotExist()
    {
        (await _sut.ReadAsync(_dir.File("layouts.json"), CancellationToken.None)).Should().BeNull("a first start has no saved layouts");
    }

    [Fact]
    public async Task ReadAsync_ShouldReturnNull_WhenTheDirectoryDoesNotExist()
    {
        (await _sut.ReadAsync(_dir.File("data", "layouts.json"), CancellationToken.None)).Should().BeNull("a fresh volume has no data directory yet");
    }

    [Fact]
    public async Task ReadAsync_ShouldThrowIOException_WhenTheFileExistsButCannotBeRead()
    {
        var path = _dir.File("layouts.json");
        await File.WriteAllTextAsync(path, Layouts);
        using var held = new FileStream(path, FileMode.Open, FileAccess.ReadWrite, FileShare.None);

        var act = () => _sut.ReadAsync(path, CancellationToken.None);

        // Null would read as "no file", and the next save would overwrite the one that could not be read.
        await act.Should().ThrowAsync<IOException>("the store moves an unreadable file aside only when it is told the read failed");
    }

    [Fact]
    public async Task WriteAsync_ShouldRoundTripTheText_WhenTheDirectoryDoesNotExist()
    {
        var temp = _dir.File("data", "layouts.json.tmp");

        await _sut.WriteAsync(temp, Layouts, CancellationToken.None);

        (await _sut.ReadAsync(temp, CancellationToken.None)).Should().Be(Layouts);
    }

    [Fact]
    public async Task WriteAsync_ShouldLeaveOnlyTheNewText_WhenTheFileAlreadyHoldsLongerText()
    {
        var temp = _dir.File("layouts.json.tmp");
        await File.WriteAllTextAsync(temp, Layouts + new string(' ', 64) + "left over from an earlier write");

        await _sut.WriteAsync(temp, Layouts, CancellationToken.None);

        (await File.ReadAllTextAsync(temp)).Should().Be(Layouts, "a stale tail would make the next read corrupt");
    }

    [Fact]
    public async Task Replace_ShouldOverwriteTheDestination_WhenItExists()
    {
        var path = _dir.File("layouts.json");
        var temp = path + ".tmp";
        await File.WriteAllTextAsync(path, """{"version":1,"layouts":{}}""");
        await File.WriteAllTextAsync(temp, Layouts);

        _sut.Replace(temp, path);

        (await File.ReadAllTextAsync(path)).Should().Be(Layouts, "a save replaces the previous file");
        File.Exists(temp).Should().BeFalse("the temp file is renamed, not copied");
    }

    [Fact]
    public async Task Move_ShouldLeaveBothFilesInPlace_WhenTheDestinationExists()
    {
        var path = _dir.File("layouts.json");
        var aside = path + ".corrupt-20261119T120000Z";
        const string Evidence = "{ not json";
        await File.WriteAllTextAsync(path, "{ also not json");
        await File.WriteAllTextAsync(aside, Evidence);

        var act = () => _sut.Move(path, aside);

        act.Should().Throw<IOException>("a file moved aside earlier is evidence and must not be overwritten");
        (await File.ReadAllTextAsync(aside)).Should().Be(Evidence);
        File.Exists(path).Should().BeTrue("a refused move leaves the source where it was");
    }

    [Fact]
    public async Task Move_ShouldRenameTheFile_WhenTheDestinationIsFree()
    {
        var path = _dir.File("layouts.json");
        var aside = path + ".corrupt-20261119T120000Z";
        await File.WriteAllTextAsync(path, "{ not json");

        _sut.Move(path, aside);

        (await File.ReadAllTextAsync(aside)).Should().Be("{ not json");
        File.Exists(path).Should().BeFalse();
    }
}
