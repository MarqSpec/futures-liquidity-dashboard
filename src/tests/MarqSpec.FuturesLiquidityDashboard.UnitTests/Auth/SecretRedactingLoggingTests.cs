using System.Collections;
using System.Text;
using MarqSpec.FuturesLiquidityDashboard.Api.Auth;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;

#pragma warning disable CA1848 // These tests call the logging extensions so the state is the shape production builds.
#pragma warning disable CA1873

namespace MarqSpec.FuturesLiquidityDashboard.UnitTests.Auth;

// reference: ARCHITECTURE.md D-30; CONVENTIONS.md §11
public sealed class SecretRedactingLoggingTests
{
    private const string Key = "synthetic-test-key-es-viewer";

    [Fact]
    public void Log_ShouldRedactTheFormattedMessage_WhenItContainsAnAccessToken()
    {
        using var harness = new Harness();
        var line = $"Request starting GET http://localhost/hubs/market?id=abc&access_token={Key}";

        harness.Logger.Log(LogLevel.Information, 0, line, null, static (value, _) => value);

        var entry = harness.Sink.Entries.Should().ContainSingle().Subject;
        entry.Message.Should().Be("Request starting GET http://localhost/hubs/market?id=abc&access_token=[redacted]");
        entry.Message.Should().NotContain(Key);
        entry.StateText.Should().NotContain(Key);
    }

    [Fact]
    public void Log_ShouldRedactStructuredState_WhenAPropertyHoldsTheQuery()
    {
        using var harness = new Harness();

        harness.Logger.LogInformation("upstream {Query}", $"id=abc&access_token={Key}");

        var entry = harness.Sink.Entries.Should().ContainSingle().Subject;
        entry.Message.Should().Be("upstream id=abc&access_token=[redacted]");
        Value(entry.State, "Query").Should().Be("id=abc&access_token=[redacted]");
        entry.StateText.Should().NotContain(Key);
    }

    [Fact]
    public void Log_ShouldRedactAStructuredValue_WhenTheFormattedLineHidesTheKey()
    {
        using var harness = new Harness();

        harness.Logger.LogInformation("Header X-Api-Key: {ApiKey} id={Id}", Key, "abc");

        var entry = harness.Sink.Entries.Should().ContainSingle().Subject;
        entry.Message.Should().Be("Header X-Api-Key: [redacted] id=abc");
        Value(entry.State, "ApiKey").Should().Be("[redacted]");
        Value(entry.State, "Id").Should().Be("abc");
        entry.StateText.Should().NotContain(Key);
    }

    [Fact]
    public void Log_ShouldRedactStructuredState_WhenAPropertyHoldsAJwt()
    {
        using var harness = new Harness();
        const string jwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.sig";

        harness.Logger.LogInformation("upstream {Token}", jwt);

        var entry = harness.Sink.Entries.Should().ContainSingle().Subject;
        entry.Message.Should().Be("upstream [redacted]");
        Value(entry.State, "Token").Should().Be("[redacted]");
    }

    [Fact]
    public void Log_ShouldKeepStructuredValues_WhenTheyHoldNoSecret()
    {
        using var harness = new Harness();

        harness.Logger.LogInformation("Streaming {Instrument} for {Count} instruments", "MES", 3);

        var entry = harness.Sink.Entries.Should().ContainSingle().Subject;
        entry.Message.Should().Be("Streaming MES for 3 instruments");
        Value(entry.State, "Instrument").Should().Be("MES");
        Value(entry.State, "Count").Should().Be(3);
        Value(entry.State, "{OriginalFormat}").Should().Be("Streaming {Instrument} for {Count} instruments");
    }

    [Fact]
    public void Log_ShouldKeepANullProperty_WhenTheStructuredValueIsNull()
    {
        using var harness = new Harness();

        harness.Logger.LogInformation("name {Name}", (string?)null);

        Value(harness.Sink.Entries.Should().ContainSingle().Subject.State, "Name").Should().BeNull();
    }

    [Fact]
    public void Log_ShouldRedactExceptionMessages_WhenTheExceptionChainContainsTheKey()
    {
        using var harness = new Harness();
        var thrown = ThrowChain();

        harness.Logger.LogError(thrown, "hub negotiate failed");

        var entry = harness.Sink.Entries.Should().ContainSingle().Subject;
        entry.Message.Should().Be("hub negotiate failed");
        var logged = entry.Exception;
        logged.Should().NotBeNull();
        logged!.Message.Should().NotContain(Key);
        logged.Message.Should().Contain("[redacted]");
        logged.InnerException.Should().NotBeNull();
        logged.InnerException!.Message.Should().NotContain(Key);
        logged.InnerException.Message.Should().Contain("access_token=[redacted]");
        logged.ToString().Should().NotContain(Key);
        logged.ToString().Should().Contain(nameof(InvalidOperationException));
        logged.ToString().Should().Contain(nameof(ArgumentException));
        logged.ToString().Should().Contain(" at ");
    }

    [Fact]
    public void Log_ShouldRedactAggregateExceptionMessages_WhenAnInnerExceptionContainsTheKey()
    {
        using var harness = new Harness();
        var ordinary = new ArgumentException("ordinary failure");
        AggregateException thrown;
        try
        {
            throw new AggregateException(
                $"X-Api-Key: {Key}",
                new InvalidOperationException($"access_token={Key}"),
                ordinary);
        }
        catch (AggregateException ex)
        {
            thrown = ex;
        }

        harness.Logger.LogError(thrown, "hub negotiate failed");

        var logged = harness.Sink.Entries.Should().ContainSingle().Subject.Exception;
        logged.Should().BeAssignableTo<AggregateException>();
        var aggregate = (AggregateException)logged!;
        aggregate.Message.Should().NotContain(Key);
        aggregate.InnerExceptions[0].Message.Should().NotContain(Key);
        aggregate.InnerExceptions[1].Should().BeSameAs(ordinary);
        aggregate.ToString().Should().NotContain(Key);
        aggregate.ToString().Should().Contain(" at ");
    }

    [Fact]
    public void Log_ShouldRedactExceptionData_WhenAValueContainsTheKey()
    {
        using var harness = new Harness();
        var exception = new InvalidOperationException("ordinary failure");
        exception.Data["query"] = $"access_token={Key}";
        exception.Data["root"] = "MES";

        harness.Logger.LogError(exception, "hub negotiate failed");

        var logged = harness.Sink.Entries.Should().ContainSingle().Subject.Exception;
        logged.Should().NotBeNull();
        logged!.Data["query"].Should().Be($"access_token=[redacted]");
        logged.Data["root"].Should().Be("MES");
        logged.ToString().Should().NotContain(Key);
    }

    [Fact]
    public void Log_ShouldRedactExceptionData_WhenTheKeyNamesTheSecret()
    {
        using var harness = new Harness();
        var exception = new InvalidOperationException("ordinary failure");
        exception.Data["access_token"] = Key;
        exception.Data["X-Api-Key"] = Key;
        exception.Data["Authorization"] = "Bearer " + Key;
        exception.Data["root"] = "MES";

        harness.Logger.LogError(exception, "hub negotiate failed");

        var logged = harness.Sink.Entries.Should().ContainSingle().Subject.Exception;
        logged.Should().NotBeNull();
        logged!.Data["access_token"].Should().Be("[redacted]");
        logged.Data["X-Api-Key"].Should().Be("[redacted]");
        logged.Data["Authorization"].Should().Be("[redacted]");
        logged.Data["root"].Should().Be("MES");
        logged.ToString().Should().NotContain(Key);
    }

    [Fact]
    public void Log_ShouldKeepTheException_WhenItsMessageHasNoSecret()
    {
        using var harness = new Harness();
        var exception = new InvalidOperationException("Streaming MES");

        harness.Logger.LogError(exception, "hub negotiate failed");

        harness.Sink.Entries.Should().ContainSingle().Subject.Exception.Should().BeSameAs(exception);
    }

    [Fact]
    public void BeginScope_ShouldRedactScopeState_WhenTheScopeNamesTheKey()
    {
        using var harness = new Harness();

        using (harness.Logger.BeginScope(new Dictionary<string, object?> { ["access_token"] = Key, ["root"] = "MES" }))
        {
            harness.Logger.LogInformation("connected");
        }

        var entry = harness.Sink.Entries.Should().ContainSingle().Subject;
        var scope = entry.Scopes.Should().ContainSingle().Subject;
        scope.Text.Should().NotContain(Key);
        Value(scope.State, "access_token").Should().Be("[redacted]");
        Value(scope.State, "root").Should().Be("MES");
    }

    [Fact]
    public void BeginScope_ShouldRedactAScopeValue_WhenTheScopeTemplateCarriesTheKey()
    {
        using var harness = new Harness();

        using (harness.Logger.BeginScope("hub access_token={Token} root={Root}", Key, "MES"))
        {
            harness.Logger.LogInformation("connected");
        }

        var entry = harness.Sink.Entries.Should().ContainSingle().Subject;
        var scope = entry.Scopes.Should().ContainSingle().Subject;
        scope.Text.Should().NotContain(Key);
        scope.Text.Should().Contain("access_token=[redacted]");
        Value(scope.State, "Token").Should().Be("[redacted]");
        Value(scope.State, "Root").Should().Be("MES");
    }

    [Fact]
    public void BeginScope_ShouldKeepScopeValues_WhenTheyHoldNoSecret()
    {
        using var harness = new Harness();

        using (harness.Logger.BeginScope(new Dictionary<string, object?> { ["root"] = "MES" }))
        {
            harness.Logger.LogInformation("connected");
        }

        var scope = harness.Sink.Entries.Should().ContainSingle().Subject.Scopes.Should().ContainSingle().Subject;
        Value(scope.State, "root").Should().Be("MES");
    }

    [Fact]
    public void BeginScope_ShouldRedactAnAnonymousScope_WhenAPropertyNamesTheKey()
    {
        using var harness = new Harness();

        using (harness.Logger.BeginScope(new { access_token = Key, root = "MES" }))
        {
            harness.Logger.LogInformation("connected");
        }

        var scope = harness.Sink.Entries.Should().ContainSingle().Subject.Scopes.Should().ContainSingle().Subject;
        scope.Text.Should().NotContain(Key);
        Value(scope.State, "access_token").Should().Be("[redacted]");
        Value(scope.State, "root").Should().Be("MES");
    }

    [Fact]
    public void Log_ShouldRedactAPropertyBag_WhenItIsNotAPairList()
    {
        using var harness = new Harness();
        var bag = new { access_token = Key, root = "MES" };

        harness.Logger.Log(LogLevel.Information, 0, bag, null, (value, _) => value?.ToString() ?? string.Empty);

        var entry = harness.Sink.Entries.Should().ContainSingle().Subject;
        entry.Message.Should().NotContain(Key);
        entry.StateText.Should().NotContain(Key);
        Value(entry.State, "access_token").Should().Be("[redacted]");
        Value(entry.State, "root").Should().Be("MES");
    }

    [Fact]
    public void Log_ShouldRedactAStringBuilder_WhenItsTextContainsTheKey()
    {
        using var harness = new Harness();
        var builder = new StringBuilder($"access_token={Key}");

        harness.Logger.LogInformation("upstream {Query}", builder);

        var entry = harness.Sink.Entries.Should().ContainSingle().Subject;
        entry.Message.Should().Be("upstream access_token=[redacted]");
        entry.StateText.Should().NotContain(Key);
        Value(entry.State, "Query").Should().Be("access_token=[redacted]");
    }

    [Fact]
    public void Log_ShouldRedactAStringBuilderInsideABag_WhenItsTextContainsTheKey()
    {
        using var harness = new Harness();
        var bag = new { query = new StringBuilder($"access_token={Key}"), root = "MES" };

        harness.Logger.Log(LogLevel.Information, 0, bag, null, (value, _) => value?.ToString() ?? string.Empty);

        var entry = harness.Sink.Entries.Should().ContainSingle().Subject;
        entry.Message.Should().NotContain(Key);
        entry.StateText.Should().NotContain(Key);
        Value(entry.State, "query").Should().Be("access_token=[redacted]");
        Value(entry.State, "root").Should().Be("MES");
    }

    [Fact]
    public void Log_ShouldReplaceState_WhenTheFormattedLineWasRedacted()
    {
        using var harness = new Harness();

        harness.Logger.Log(LogLevel.Information, 0, new QueryText(Key), null, (value, _) => value?.ToString() ?? string.Empty);

        var entry = harness.Sink.Entries.Should().ContainSingle().Subject;
        entry.Message.Should().Be($"access_token=[redacted]");
        entry.StateText.Should().NotContain(Key);
        entry.State.Should().BeOfType<string>();
    }

    [Fact]
    public void Log_ShouldNotReturnACyclicPropertyBag_WhenItCarriesTheKey()
    {
        using var harness = new Harness();
        var loop = new Bag { access_token = Key };
        loop.Next = loop;

        harness.Logger.Log(LogLevel.Information, 0, loop, null, (value, _) => value?.ToString() ?? string.Empty);

        var entry = harness.Sink.Entries.Should().ContainSingle().Subject;
        entry.StateText.Should().NotContain(Key);
        Value(entry.State, "access_token").Should().Be("[redacted]");
        Value(entry.State, "Next").Should().NotBeSameAs(loop);
        Value(entry.State, "Next")!.ToString().Should().NotContain(Key);
    }

    [Fact]
    public void Log_ShouldRedactCollectionElements_WhenAnArrayOrListHoldsTheKey()
    {
        using var harness = new Harness();
        var bag = new
        {
            queries = new List<string> { $"access_token={Key}", "MES" },
            hosts = new[] { "MES.Z26", $"X-Api-Key: {Key}" },
        };

        harness.Logger.Log(LogLevel.Information, 0, bag, null, (value, _) => value?.ToString() ?? string.Empty);

        var entry = harness.Sink.Entries.Should().ContainSingle().Subject;
        entry.Message.Should().NotContain(Key);
        entry.StateText.Should().NotContain(Key);
        Values(Value(entry.State, "queries")).Should().Equal($"access_token=[redacted]", "MES");
        Values(Value(entry.State, "hosts")).Should().Equal("MES.Z26", "X-Api-Key: [redacted]");
    }

    [Fact]
    public void Log_ShouldRedactTheUnwalkedTail_WhenACollectionExceedsTheWalkCap()
    {
        using var harness = new Harness();
        var items = new List<string>(300);
        for (var i = 0; i < 300; i++)
        {
            items.Add(i is 0 or 256 ? $"access_token={Key}" : "MES");
        }

        harness.Logger.Log(LogLevel.Information, 0, items, null, (value, _) => value?.ToString() ?? string.Empty);

        var entry = harness.Sink.Entries.Should().ContainSingle().Subject;
        var pairs = Pairs(entry.State);
        pairs.Should().HaveCount(257);
        pairs[0].Value.Should().Be($"access_token=[redacted]");
        pairs[1].Value.Should().Be("MES");
        pairs[^1].Value!.ToString().Should().Contain("access_token=[redacted]").And.NotContain(Key);
        entry.StateText.Should().NotContain(Key);
        entry.Message.Should().NotContain(Key);
    }

    [Fact]
    public void Log_ShouldRedactASpacedAccessToken_WhenTheBagIsPastTheWalkCap()
    {
        using var harness = new Harness();
        var head = new SpacedLink();
        var cursor = head;
        for (var i = 0; i < 12; i++)
        {
            cursor.Next = new SpacedLink();
            cursor = cursor.Next;
        }

        cursor.Token = Key;

        harness.Logger.Log(LogLevel.Information, 0, head, null, (value, _) => value?.ToString() ?? string.Empty);

        var entry = harness.Sink.Entries.Should().ContainSingle().Subject;
        entry.Message.Should().NotContain(Key);
        entry.StateText.Should().NotContain(Key);
        Dump(entry.State, []).Should().NotContain(Key);
    }

    [Fact]
    public void Log_ShouldRedactANestedPropertyBag_WhenExceptionDataHoldsOne()
    {
        using var harness = new Harness();
        var exception = new InvalidOperationException("ordinary failure");
        exception.Data["context"] = new { access_token = Key, root = "MES" };
        exception.Data["queries"] = new List<string> { $"access_token={Key}", "MES" };

        harness.Logger.LogError(exception, "hub negotiate failed");

        var logged = harness.Sink.Entries.Should().ContainSingle().Subject.Exception;
        logged.Should().NotBeNull();
        Value(logged!.Data["context"], "access_token").Should().Be("[redacted]");
        Value(logged.Data["context"], "root").Should().Be("MES");
        Values(logged.Data["queries"]).Should().Equal($"access_token=[redacted]", "MES");
        logged.Data["context"]!.ToString().Should().NotContain(Key);
        logged.Data["queries"]!.ToString().Should().NotContain(Key);
        logged.ToString().Should().NotContain(Key);
    }

    [Fact]
    public void Log_ShouldNotLeakAKeyPastTheWalkCap_WhenTheBagIsDeep()
    {
        using var harness = new Harness();
        var head = new Bag();
        var cursor = head;
        for (var i = 0; i < 10; i++)
        {
            cursor.Next = new Bag();
            cursor = cursor.Next;
        }

        cursor.access_token = Key;

        harness.Logger.Log(LogLevel.Information, 0, head, null, (value, _) => value?.ToString() ?? string.Empty);

        var entry = harness.Sink.Entries.Should().ContainSingle().Subject;
        ContainsSecret(entry.State, Key, []).Should().BeFalse();
    }

    [Fact]
    public void Log_ShouldNotThrow_WhenTheFormatterIsMissing()
    {
        using var harness = new Harness();

        var act = () => harness.Logger.Log(LogLevel.Information, 0, $"access_token={Key}", null, null!);

        act.Should().NotThrow();
        var entry = harness.Sink.Entries.Should().ContainSingle().Subject;
        entry.Message.Should().NotContain(Key);
        entry.StateText.Should().NotContain(Key);
    }

    [Fact]
    public void Log_ShouldNotThrow_WhenTheFormatterThrows()
    {
        using var harness = new Harness();

        var act = () => harness.Logger.Log(
            LogLevel.Warning,
            0,
            $"access_token={Key}",
            null,
            static (_, _) => throw new InvalidOperationException("boom"));

        act.Should().NotThrow();
        var entry = harness.Sink.Entries.Should().ContainSingle().Subject;
        entry.Message.Should().Be("access_token=[redacted]");
        entry.StateText.Should().NotContain(Key);
    }

    [Fact]
    public void Log_ShouldSkipTheLine_WhenTheLevelIsDisabled()
    {
        using var harness = new Harness();

        var act = () => harness.Logger.Log(
            LogLevel.Trace,
            0,
            $"access_token={Key}",
            null,
            static (_, _) => throw new InvalidOperationException("boom"));

        act.Should().NotThrow();
        harness.Sink.Entries.Should().BeEmpty();
    }

    [Fact]
    public void Log_ShouldNotThrow_WhenTheExceptionCannotBeRendered()
    {
        using var harness = new Harness();

        var act = () => harness.Logger.LogError(new UnreadableException(), "hub negotiate failed");

        act.Should().NotThrow();
        var entry = harness.Sink.Entries.Should().ContainSingle().Subject;
        entry.Message.Should().Be("hub negotiate failed");
        entry.Exception.Should().NotBeNull();
        entry.ExceptionText.Should().NotContain(Key);
    }

    [Fact]
    public void Log_ShouldNotThrow_WhenStructuredStateCannotBeRead()
    {
        using var harness = new Harness();

        var act = () => harness.Logger.Log(LogLevel.Warning, 0, new UnreadableState(), null, static (_, _) => "ok");

        act.Should().NotThrow();
        harness.Sink.Entries.Should().ContainSingle().Subject.Message.Should().Be("ok");
    }

    [Fact]
    public void BeginScope_ShouldNotThrow_WhenTheScopeCannotBeRendered()
    {
        using var harness = new Harness();

        var act = () =>
        {
            using (harness.Logger.BeginScope(new UnreadableState()))
            {
                harness.Logger.LogInformation("connected");
            }
        };

        act.Should().NotThrow();
        harness.Sink.Entries.Should().ContainSingle().Subject.Message.Should().Be("connected");
    }

    private static InvalidOperationException ThrowChain()
    {
        try
        {
            try
            {
                throw new ArgumentException($"access_token={Key}");
            }
            catch (ArgumentException inner)
            {
                throw new InvalidOperationException($"Authorization: Bearer {Key}", inner);
            }
        }
        catch (InvalidOperationException ex)
        {
            return ex;
        }
    }

    private static bool ContainsSecret(object? value, string key, HashSet<object> seen)
    {
        if (value is null)
        {
            return false;
        }

        if (value is string text)
        {
            return text.Contains(key, StringComparison.Ordinal);
        }

        if (!seen.Add(value))
        {
            return false;
        }

        if (value is Bag bag && bag.access_token is not null && bag.access_token.Contains(key, StringComparison.Ordinal))
        {
            return true;
        }

        if (value is IEnumerable<KeyValuePair<string, object?>> pairs)
        {
            foreach (var pair in pairs)
            {
                if (ContainsSecret(pair.Value, key, seen))
                {
                    return true;
                }
            }
        }

        return false;
    }

    private static List<string?> Values(object? state)
    {
        var pairs = Pairs(state);
        return pairs.Select(pair => pair.Value?.ToString()).ToList();
    }

    private static string Dump(object? value, HashSet<object> seen)
    {
        if (value is null)
        {
            return string.Empty;
        }

        if (value is string text)
        {
            return text;
        }

        if (!seen.Add(value))
        {
            return string.Empty;
        }

        var rendered = new StringBuilder(value.ToString());
        if (value is IEnumerable<KeyValuePair<string, object?>> pairs)
        {
            foreach (var pair in pairs)
            {
                rendered.Append(pair.Key);
                rendered.Append(Dump(pair.Value, seen));
            }
        }

        return rendered.ToString();
    }

    private static object? Value(object? state, string key)
    {
        var pairs = Pairs(state);
        pairs.Should().Contain(pair => pair.Key == key);
        return pairs.Single(pair => pair.Key == key).Value;
    }

    private static List<KeyValuePair<string, object?>> Pairs(object? state)
    {
        if (state is IReadOnlyList<KeyValuePair<string, object?>> list)
        {
            return list.ToList();
        }

        if (state is IEnumerable<KeyValuePair<string, object?>> pairs)
        {
            return pairs.ToList();
        }

        throw new InvalidOperationException($"State was {state?.GetType().FullName ?? "null"}, not structured properties.");
    }

    private sealed class Harness : IDisposable
    {
        public Harness()
        {
            Sink = new CapturingLoggerProvider();
            var services = new ServiceCollection();
            services.AddLogging(logging =>
            {
                logging.AddProvider(Sink);
                logging.RedactSecrets();
            });
            Services = services.BuildServiceProvider();
            Logger = Services.GetRequiredService<ILogger<SecretRedactingLoggingTests>>();
        }

        public CapturingLoggerProvider Sink { get; }

        public ILogger Logger { get; }

        private ServiceProvider Services { get; }

        public void Dispose() => Services.Dispose();
    }

    private sealed class CapturingLoggerProvider : ILoggerProvider, ISupportExternalScope
    {
        private IExternalScopeProvider? _scopes;

        public List<CapturedLog> Entries { get; } = [];

        public void SetScopeProvider(IExternalScopeProvider scopeProvider) => _scopes = scopeProvider;

        public ILogger CreateLogger(string categoryName) => new CapturingLogger(this);

        public void Dispose()
        {
        }

        private sealed class CapturingLogger(CapturingLoggerProvider owner) : ILogger
        {
            public IDisposable BeginScope<TState>(TState state)
                where TState : notnull => NullScope.Instance;

            public bool IsEnabled(LogLevel logLevel) => true;

            public void Log<TState>(LogLevel logLevel, EventId eventId, TState state, Exception? exception, Func<TState, Exception?, string> formatter)
            {
                var scopes = new List<object?>();
                owner._scopes?.ForEachScope(static (scope, list) => list.Add(scope), scopes);
                var capturedScopes = new List<CapturedScope>(scopes.Count);
                foreach (var scope in scopes)
                {
                    capturedScopes.Add(new CapturedScope(scope, scope?.ToString() ?? string.Empty));
                }

                string? exceptionText = null;
                if (exception is not null)
                {
                    exceptionText = exception.ToString();
                    _ = exception.Message;
                    Walk(exception);
                }

                owner.Entries.Add(new CapturedLog(formatter(state, exception), state, state?.ToString() ?? string.Empty, exception, exceptionText, capturedScopes));
            }

            private static void Walk(Exception exception)
            {
                foreach (DictionaryEntry entry in exception.Data)
                {
                    _ = entry.Value?.ToString();
                }

                if (exception is AggregateException aggregate)
                {
                    foreach (var inner in aggregate.InnerExceptions)
                    {
                        _ = inner.Message;
                    }

                    return;
                }

                if (exception.InnerException is not null)
                {
                    _ = exception.InnerException.Message;
                }
            }
        }
    }

    private sealed record CapturedLog(
        string Message,
        object? State,
        string StateText,
        Exception? Exception,
        string? ExceptionText,
        IReadOnlyList<CapturedScope> Scopes);

    private sealed record CapturedScope(object? State, string Text);

    private sealed class NullScope : IDisposable
    {
        public static readonly NullScope Instance = new();

        public void Dispose()
        {
        }
    }

    private sealed class QueryText(string key)
    {
        public override string ToString() => $"access_token={key}";
    }

    private sealed class Bag
    {
        public Bag? Next { get; set; }

        public string? access_token { get; set; }
    }

    /// <summary>ToString uses spaced <c>access_token =</c> pairs. The property name is not itself a secret key.</summary>
    private sealed class SpacedLink
    {
        public SpacedLink? Next { get; set; }

        public string? Token { get; set; }

        public override string ToString() =>
            Token is null ? $"{{ Next = {Next} }}" : $"{{ access_token = {Token} }}";
    }

    private sealed class UnreadableException : Exception
    {
        public UnreadableException()
        {
            Data["boom"] = new UnreadableValue();
        }

        public override string Message => throw new InvalidOperationException("message");

        public override string? StackTrace => throw new InvalidOperationException("stack");

        public override string ToString() => throw new InvalidOperationException("text");

        private sealed class UnreadableValue
        {
            public override string ToString() => throw new InvalidOperationException("value");
        }
    }

    private sealed class UnreadableState : IReadOnlyList<KeyValuePair<string, object?>>
    {
        public int Count => 1;

        public KeyValuePair<string, object?> this[int index] => throw new InvalidOperationException("index");

        public IEnumerator<KeyValuePair<string, object?>> GetEnumerator() => throw new InvalidOperationException("enum");

        IEnumerator IEnumerable.GetEnumerator() => GetEnumerator();
    }
}
