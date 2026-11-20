using MarqSpec.FuturesLiquidityDashboard.Api.Feedback;

namespace MarqSpec.FuturesLiquidityDashboard.IntegrationTests;

// The unit tier fakes this seam (CONVENTIONS.md §8.1), so these are the only tests of the real disk under it.
[Trait("Deployment", "None")]
public sealed class PhysicalFeedbackBudgetFilesTests : IDisposable
{
    private const string Budget = """{"month":"2026-11","spentUsd":1.25,"budgetUsd":100}""";

    private readonly TempDirectory _dir = new();
    private readonly PhysicalFeedbackBudgetFiles _sut = new();

    public void Dispose() => _dir.Dispose();

    [Fact]
    public void Read_ShouldReturnNull_WhenTheFileDoesNotExist()
    {
        _sut.Read(_dir.File("feedback-budget.json")).Should().BeNull("a first start has no file and begins at zero spend");
    }

    [Fact]
    public void Read_ShouldReturnNull_WhenTheDirectoryDoesNotExist()
    {
        _sut.Read(_dir.File("data", "feedback-budget.json")).Should().BeNull("a fresh volume has no data directory yet");
    }

    [Fact]
    public void Read_ShouldThrowIOException_WhenTheFileExistsButCannotBeRead()
    {
        var path = _dir.File("feedback-budget.json");
        File.WriteAllText(path, Budget);
        using var held = new FileStream(path, FileMode.Open, FileAccess.ReadWrite, FileShare.None);

        var act = () => _sut.Read(path);

        // Null would read as "no file", and the next save would overwrite the one that could not be read.
        act.Should().Throw<IOException>("the store moves an unreadable file aside only when it is told the read failed");
    }

    [Fact]
    public void Write_ShouldWriteTheFile_WhenTheDirectoryDoesNotExist()
    {
        var temp = _dir.File("data", "feedback-budget.json" + FeedbackBudgetStore.TempSuffix);

        _sut.Write(temp, Budget);

        File.ReadAllText(temp).Should().Be(Budget);
        _sut.Read(temp).Should().Be(Budget);
    }

    [Fact]
    public void Write_ShouldLeaveOnlyTheNewText_WhenTheFileAlreadyHoldsLongerText()
    {
        var temp = _dir.File("feedback-budget.json" + FeedbackBudgetStore.TempSuffix);
        File.WriteAllText(temp, Budget + new string(' ', 64) + "left over from an earlier write");

        _sut.Write(temp, Budget);

        File.ReadAllText(temp).Should().Be(Budget, "a stale tail would make the next read corrupt");
    }

    [Fact]
    public void Move_ShouldReplaceTheDestination_WhenOverwriteIsTrue()
    {
        var path = _dir.File("feedback-budget.json");
        var temp = path + FeedbackBudgetStore.TempSuffix;
        File.WriteAllText(path, """{"month":"2026-10","spentUsd":9,"budgetUsd":100}""");
        File.WriteAllText(temp, Budget);

        _sut.Move(temp, path, overwrite: true);

        File.ReadAllText(path).Should().Be(Budget, "a save replaces the previous budget");
        File.Exists(temp).Should().BeFalse("the temp file is renamed, not copied");
    }

    [Fact]
    public void Move_ShouldLeaveBothFilesInPlace_WhenTheDestinationExistsWithoutOverwrite()
    {
        var path = _dir.File("feedback-budget.json");
        var aside = path + FeedbackBudgetStore.CorruptInfix + "20261119T120000Z";
        const string Evidence = "{ not json";
        File.WriteAllText(path, "{ also not json");
        File.WriteAllText(aside, Evidence);

        var act = () => _sut.Move(path, aside, overwrite: false);

        act.Should().Throw<IOException>("a file moved aside earlier is evidence and must not be overwritten");
        File.ReadAllText(aside).Should().Be(Evidence);
        File.Exists(path).Should().BeTrue("a refused move leaves the source where it was");
    }

    [Fact]
    public void Move_ShouldRenameTheFileAside_WhenTheDestinationIsFreeWithoutOverwrite()
    {
        var path = _dir.File("feedback-budget.json");
        var aside = path + FeedbackBudgetStore.CorruptInfix + "20261119T120000Z";
        File.WriteAllText(path, "{ not json");

        _sut.Move(path, aside, overwrite: false);

        File.ReadAllText(aside).Should().Be("{ not json");
        File.Exists(path).Should().BeFalse("the next save writes a fresh file in its place");
    }
}
