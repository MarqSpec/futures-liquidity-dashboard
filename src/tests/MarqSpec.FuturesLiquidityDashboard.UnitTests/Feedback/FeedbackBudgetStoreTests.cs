using MarqSpec.FuturesLiquidityDashboard.Api.Feedback;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using Microsoft.Extensions.Time.Testing;

namespace MarqSpec.FuturesLiquidityDashboard.UnitTests.Feedback;

// reference: REQUIREMENTS.md FR-74, NFR-9 (the monthly cap survives a restart)
// reference: CONVENTIONS.md §8.1 (no file I/O: the disk is the in-memory FakeBudgetFiles)

/// <summary>An in-memory disk for the budget store: files by path, and every operation in order.</summary>
public sealed class FakeBudgetFiles : IFeedbackBudgetFiles
{
    public Dictionary<string, string> Files { get; } = [];

    public List<string> Operations { get; } = [];

    public IOException? FailReadWith { get; set; }

    public IOException? FailWriteWith { get; set; }

    /// <summary>Thrown by the next move only, then cleared, so the moves after it succeed.</summary>
    public IOException? FailNextMoveWith { get; set; }

    public string? Read(string path)
    {
        Operations.Add($"read {path}");
        return FailReadWith is not null ? throw FailReadWith : Files.GetValueOrDefault(path);
    }

    public void Write(string path, string content)
    {
        Operations.Add($"write {path}");
        Files[path] = FailWriteWith is not null ? throw FailWriteWith : content;
    }

    public void Move(string source, string destination, bool overwrite)
    {
        Operations.Add($"move {source} -> {destination}");
        if (FailNextMoveWith is { } failure)
        {
            FailNextMoveWith = null;
            throw failure;
        }

        if (!Files.TryGetValue(source, out var content))
        {
            throw new FileNotFoundException(source);
        }

        Files[destination] = content;
        Files.Remove(source);
    }
}

public sealed class FeedbackBudgetStoreTests
{
    private const string FilePath = "/data/feedback-budget.json";

    private readonly FakeBudgetFiles _disk = new();
    private readonly FakeTimeProvider _time = new(new DateTimeOffset(2026, 11, 10, 12, 0, 0, TimeSpan.Zero));
    private readonly ILogger _logger = A.Fake<ILogger>();

    public FeedbackBudgetStoreTests() => A.CallTo(() => _logger.IsEnabled(A<LogLevel>._)).Returns(true);

    private FeedbackBudgetStore Store() => new(FilePath, _disk, _time, _logger);

    private FeedbackBudget Budget(decimal cap = 100m, string? apiKey = null) =>
        new(_time, Options.Create(new FeedbackOptions { MonthlyBudgetUsd = cap, ApiKey = apiKey }), Store());

    private int Warnings() => Fake.GetCalls(_logger).Count(c => c.Method.Name == nameof(ILogger.Log) && c.Arguments[0] is LogLevel.Warning);

    [Fact]
    public void Current_ShouldKeepSpendCapAndMonth_WhenTheBudgetIsRebuiltInTheSameMonth()
    {
        var first = Budget(cap: 50m);
        first.Record([FeedbackTestData.Usage(input: 1_000_000)]);
        var before = first.Current();

        var restarted = Budget(cap: 50m);

        restarted.Current().Should().Be(before);
        restarted.Current().Should().Be(new BudgetState(4m, 50m, "2026-11", new DateTimeOffset(2026, 12, 1, 0, 0, 0, TimeSpan.Zero).ToUnixTimeMilliseconds()));
    }

    [Fact]
    public void Current_ShouldKeepCountingFromTheSavedSpend_WhenARestartedBudgetRecordsMore()
    {
        Budget().Record([FeedbackTestData.Usage(input: 1_000_000)]);

        var restarted = Budget();
        restarted.Record([FeedbackTestData.Usage(input: 1_000_000)]);

        restarted.Current().SpentUsd.Should().Be(8m);
        Budget().Current().SpentUsd.Should().Be(8m);
    }

    [Fact]
    public void Current_ShouldStartTheNewMonthAtZero_WhenTheSavedFileIsFromAnEarlierMonth()
    {
        Budget().Record([FeedbackTestData.Usage(input: 1_000_000)]);
        _time.SetUtcNow(new DateTimeOffset(2026, 12, 1, 0, 0, 0, TimeSpan.Zero));

        var restarted = Budget();

        restarted.Current().Should().Be(new BudgetState(0m, 100m, "2026-12", new DateTimeOffset(2027, 1, 1, 0, 0, 0, TimeSpan.Zero).ToUnixTimeMilliseconds()));
    }

    [Fact]
    public void Record_ShouldSaveTheNewMonthFromZero_WhenTheMonthTurnsWhileRunning()
    {
        var budget = Budget();
        budget.Record([FeedbackTestData.Usage(input: 1_000_000)]);
        _time.SetUtcNow(new DateTimeOffset(2026, 12, 2, 0, 0, 0, TimeSpan.Zero));

        budget.Record([FeedbackTestData.Usage(input: 500_000)]);

        Budget().Current().Should().Match<BudgetState>(s => s.SpentUsd == 2m && s.Month == "2026-12");
    }

    [Theory]
    [InlineData("")]
    [InlineData("{ not json")]
    [InlineData("null")]
    [InlineData("""{"month":"2026-11","spentUsd":-5,"budgetUsd":100}""")]
    [InlineData("""{"month":"","spentUsd":5,"budgetUsd":100}""")]
    [InlineData("""{"month":"  ","spentUsd":5,"budgetUsd":100}""")]
    [InlineData("""{"month":"2026-1","spentUsd":5,"budgetUsd":100}""")]
    [InlineData("""{"month":"2026-13","spentUsd":5,"budgetUsd":100}""")]
    [InlineData("""{"month":"2026-11 ","spentUsd":5,"budgetUsd":100}""")]
    [InlineData("""{"month":"2026-11-01","spentUsd":5,"budgetUsd":100}""")]
    [InlineData("""{"month":"November","spentUsd":5,"budgetUsd":100}""")]
    [InlineData("""{"month":"2026-11","budgetUsd":100}""")]
    public void Current_ShouldStartAtZeroAndWarn_WhenTheFileIsCorrupt(string content)
    {
        _disk.Files[FilePath] = content;

        var budget = Budget();

        budget.Current().SpentUsd.Should().Be(0m);
        Warnings().Should().Be(1);
    }

    [Fact]
    public void Load_ShouldAcceptAZeroSpend_WhenTheFileIsWellFormed()
    {
        _disk.Files[FilePath] = """{"month":"2026-11","spentUsd":0,"budgetUsd":100}""";

        Store().Load().Should().Be(new PersistedBudget("2026-11", 0m, 100m));
        Warnings().Should().Be(0);
    }

    [Theory]
    [InlineData("""{"month":"2026-1","spentUsd":7,"budgetUsd":100}""")]
    [InlineData("""{"month":"2026-11","budgetUsd":100}""")]
    public void Record_ShouldMoveAMalformedFileAsideBeforeTheFirstWrite_WhenTheFileParsesButIsMalformed(string content)
    {
        _disk.Files[FilePath] = content;
        var budget = Budget();
        Warnings().Should().Be(1);

        budget.Record([FeedbackTestData.Usage(input: 1_000_000)]);

        var aside = FilePath + FeedbackBudgetStore.CorruptInfix + "20261110T120000Z";
        _disk.Files[aside].Should().Be(content, "the malformed file is the evidence and must not be overwritten");
        _disk.Operations.Should().ContainInOrder($"move {FilePath} -> {aside}", $"write {FilePath}.tmp", $"move {FilePath}.tmp -> {FilePath}");
        Budget().Current().SpentUsd.Should().Be(4m);
    }

    [Fact]
    public void Current_ShouldStartAtZeroAndWarn_WhenTheFileCannotBeRead()
    {
        _disk.Files[FilePath] = """{"month":"2026-11","spentUsd":9,"budgetUsd":100}""";
        _disk.FailReadWith = new IOException("locked");

        Budget().Current().SpentUsd.Should().Be(0m);

        Warnings().Should().Be(1);
    }

    [Fact]
    public void Current_ShouldStartAtZeroWithoutWarning_WhenTheFileIsMissing()
    {
        Budget().Current().SpentUsd.Should().Be(0m);

        _disk.Files.Should().BeEmpty();
        Warnings().Should().Be(0);
    }

    [Fact]
    public void Record_ShouldMoveACorruptFileAsideBeforeTheFirstWrite_WhenTheFileWasCorrupt()
    {
        _disk.Files[FilePath] = "{ not json";
        var budget = Budget();
        Warnings().Should().Be(1);

        budget.Record([FeedbackTestData.Usage(input: 1_000_000)]);

        var aside = FilePath + FeedbackBudgetStore.CorruptInfix + "20261110T120000Z";
        _disk.Files[aside].Should().Be("{ not json");
        _disk.Operations.Should().ContainInOrder($"move {FilePath} -> {aside}", $"write {FilePath}.tmp", $"move {FilePath}.tmp -> {FilePath}");
        Warnings().Should().Be(2, "the move aside is logged too");
        Budget().Current().SpentUsd.Should().Be(4m);
    }

    [Fact]
    public void Record_ShouldMoveAsideOnlyOnce_WhenSeveralCallsFollowACorruptFile()
    {
        _disk.Files[FilePath] = "{ not json";
        var budget = Budget();

        budget.Record([FeedbackTestData.Usage(input: 1_000_000)]);
        budget.Record([FeedbackTestData.Usage(input: 1_000_000)]);

        _disk.Operations.Count(o => o.Contains(FeedbackBudgetStore.CorruptInfix, StringComparison.Ordinal)).Should().Be(1);
        _disk.Files.Keys.Count(k => k.Contains(FeedbackBudgetStore.CorruptInfix, StringComparison.Ordinal)).Should().Be(1);
    }

    [Fact]
    public void Record_ShouldNotMoveAnything_WhenTheFileWasMissing()
    {
        Budget().Record([FeedbackTestData.Usage(input: 1_000_000)]);

        _disk.Operations.Should().NotContain(o => o.Contains(FeedbackBudgetStore.CorruptInfix, StringComparison.Ordinal));
        _disk.Files.Keys.Should().BeEquivalentTo(FilePath);
    }

    [Fact]
    public void Record_ShouldStillSave_WhenMovingACorruptFileAsideFailsOnce()
    {
        _disk.Files[FilePath] = "{ not json";
        var budget = Budget();
        _disk.FailNextMoveWith = new IOException("denied");

        var act = () => budget.Record([FeedbackTestData.Usage(input: 1_000_000)]);

        act.Should().NotThrow();
        Budget().Current().SpentUsd.Should().Be(4m, "the save must still reach the disk when the move aside fails");
        var aside = FilePath + FeedbackBudgetStore.CorruptInfix + "20261110T120000Z";
        _disk.Operations.Should().ContainInOrder($"move {FilePath} -> {aside}", $"write {FilePath}.tmp", $"move {FilePath}.tmp -> {FilePath}");
        _disk.Files.Should().NotContainKey(aside, "the move aside was the one that failed");
        Warnings().Should().Be(2, "the failed move aside is logged after the load's warning");
    }

    [Fact]
    public void Save_ShouldWriteTheTempFileThenReplaceTheTarget_WhenAFileExists()
    {
        var store = Store();
        _disk.Files[FilePath] = """{"month":"2026-11","spentUsd":1,"budgetUsd":100}""";
        _disk.Files[FilePath + FeedbackBudgetStore.TempSuffix] = "stale half-written garbage";

        store.Save(new PersistedBudget("2026-11", 2m, 100m));

        _disk.Operations.Should().Equal($"write {FilePath}.tmp", $"move {FilePath}.tmp -> {FilePath}");
        _disk.Files.Keys.Should().BeEquivalentTo(FilePath);
        store.Load().Should().Be(new PersistedBudget("2026-11", 2m, 100m));
    }

    [Fact]
    public void Save_ShouldWarnAndNotThrow_WhenTheWriteFails()
    {
        _disk.FailWriteWith = new IOException("disk full");

        var act = () => Store().Save(new PersistedBudget("2026-11", 1m, 100m));

        act.Should().NotThrow();
        Warnings().Should().Be(1);
    }

    [Fact]
    public void Save_ShouldHoldOnlyMonthSpendAndCap_WhenAKeyIsConfigured()
    {
        Budget(apiKey: FeedbackTestData.SyntheticKey).Record([FeedbackTestData.Usage(input: 1_000_000)]);

        var text = _disk.Files[FilePath];

        System.Text.Json.JsonDocument.Parse(text).RootElement.EnumerateObject().Select(p => p.Name).Should().BeEquivalentTo("month", "spentUsd", "budgetUsd");
        text.Should().NotContain(FeedbackTestData.SyntheticKey).And.NotContain("sk-ant");
    }

    [Fact]
    public void Record_ShouldWriteNothing_WhenTheUsageCostsNothing()
    {
        Budget().Record([]);

        _disk.Operations.Should().NotContain(o => o.StartsWith("write", StringComparison.Ordinal));
    }
}
