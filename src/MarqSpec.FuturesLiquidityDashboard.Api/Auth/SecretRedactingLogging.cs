using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace MarqSpec.FuturesLiquidityDashboard.Api.Auth;

/// <summary>
/// Wraps the host's loggers so formatted lines, structured state, scopes and exception text pass through
/// <see cref="SecretRedactor"/> (ARCHITECTURE.md D-30).
/// </summary>
public static class SecretRedactingLogging
{
    public static ILoggingBuilder RedactSecrets(this ILoggingBuilder logging)
    {
        ArgumentNullException.ThrowIfNull(logging);
        var prior = logging.Services.Where(d => d.ServiceType == typeof(ILoggerFactory)).ToList();
        foreach (var descriptor in prior)
        {
            logging.Services.Remove(descriptor);
        }

        logging.Services.AddSingleton<ILoggerFactory>(Create);
        return logging;
    }

    private static ILoggerFactory Create(IServiceProvider services)
    {
        var inner = new LoggerFactory(
            services.GetServices<ILoggerProvider>(),
            services.GetRequiredService<IOptionsMonitor<LoggerFilterOptions>>());
        return new RedactingLoggerFactory(inner);
    }

    private sealed class RedactingLoggerFactory(LoggerFactory inner) : ILoggerFactory
    {
        public void AddProvider(ILoggerProvider provider) => inner.AddProvider(provider);

        public ILogger CreateLogger(string categoryName) => new RedactingLogger(inner.CreateLogger(categoryName));

        public void Dispose() => inner.Dispose();
    }

    private sealed class RedactingLogger(ILogger inner) : ILogger
    {
        public IDisposable? BeginScope<TState>(TState state)
            where TState : notnull => inner.BeginScope(SecretLogRedaction.Scope(state));

        public bool IsEnabled(LogLevel logLevel) => inner.IsEnabled(logLevel);

        public void Log<TState>(LogLevel logLevel, EventId eventId, TState state, Exception? exception, Func<TState, Exception?, string> formatter)
        {
            if (!IsEnabled(logLevel))
            {
                return;
            }

            var originalMessage = Message(formatter, state, exception);
            var redactedMessage = SecretRedactor.Redact(originalMessage);
            var loggedException = SecretLogRedaction.RedactException(exception);
            if (SecretLogRedaction.TryState(state, originalMessage, redactedMessage, out var redactedState))
            {
                inner.Log(logLevel, eventId, redactedState, loggedException, static (value, _) => value.Formatted);
                return;
            }

            if (state is string text)
            {
                var redactedText = SecretRedactor.Redact(text);
                inner.Log(
                    logLevel,
                    eventId,
                    string.Equals(redactedText, text, StringComparison.Ordinal) ? text : redactedText,
                    loggedException,
                    (_, _) => redactedMessage);
                return;
            }

            if (!string.Equals(originalMessage, redactedMessage, StringComparison.Ordinal))
            {
                inner.Log(logLevel, eventId, redactedMessage, loggedException, (_, _) => redactedMessage);
                return;
            }

            var rendered = SecretLogRedaction.Render(state);
            var redactedRendered = SecretRedactor.Redact(rendered);
            if (!string.Equals(redactedRendered, rendered, StringComparison.Ordinal))
            {
                inner.Log(logLevel, eventId, redactedRendered, loggedException, (_, _) => redactedMessage);
                return;
            }

            inner.Log(logLevel, eventId, state, loggedException, (_, _) => redactedMessage);
        }

        private static string Message<TState>(Func<TState, Exception?, string>? formatter, TState state, Exception? exception)
        {
            if (formatter is null)
            {
                return SecretLogRedaction.Render(state);
            }

            try
            {
                return formatter(state, exception) ?? string.Empty;
            }
            catch (Exception)
            {
                // The line still has to be redacted when the caller's formatter throws.
                return SecretLogRedaction.Render(state);
            }
        }
    }
}
