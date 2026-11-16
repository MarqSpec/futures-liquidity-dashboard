namespace MarqSpec.FuturesLiquidityDashboard.Ingestion.ProjectX;

/// <summary>
/// The TopstepX login is one session. A second login (the trading platform, or this process) closes the other
/// with <c>StoppedForSessionConflict</c>. Reconnecting would fight that session, so the feed stops.
/// </summary>
public static class ProjectXSessionGuard
{
    public static bool IsConflict(string? message)
    {
        if (string.IsNullOrWhiteSpace(message))
        {
            return false;
        }

        return message.Contains("StoppedForSessionConflict", StringComparison.OrdinalIgnoreCase)
            || message.Contains("SessionConflict", StringComparison.OrdinalIgnoreCase)
            || message.Contains("session conflict", StringComparison.OrdinalIgnoreCase);
    }

    public static bool IsConflict(Exception? exception)
    {
        for (var current = exception; current is not null; current = current.InnerException)
        {
            if (current is ProjectXSessionConflictException || IsConflict(current.Message))
            {
                return true;
            }
        }

        return false;
    }
}

/// <summary>The market hub closed because another login holds the account. The process must not reconnect.</summary>
public sealed class ProjectXSessionConflictException : InvalidOperationException
{
    public const string StopMessage =
        "TopstepX closed this session (StoppedForSessionConflict). Another login is using the account. "
        + "This process stopped and will not reconnect. Close the other session, or leave this one stopped, then start again.";

    public ProjectXSessionConflictException()
        : base(StopMessage)
    {
    }
}
