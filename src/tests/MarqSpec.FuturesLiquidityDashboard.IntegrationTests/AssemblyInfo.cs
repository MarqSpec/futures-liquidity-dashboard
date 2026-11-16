using Xunit;

// Each host warms every catalog product. Two hosts at once miss the ready deadline on a small machine.
[assembly: CollectionBehavior(DisableTestParallelization = true)]
