import { z } from "zod";

// The simulated position on the saved layout (REQUIREMENTS.md FR-72, UC-20; ARCHITECTURE.md D-57). A chart annotation: it is
// never sent anywhere as an order (REQUIREMENTS.md FR-6). The rules mirror the API's SimulatedPosition.Validate.

export const maxPositionQuantity = 100;
export const maxPositionTargets = 3;

export const positionSides = ["long", "short"] as const;
export const positionEntryTypes = ["limit", "market"] as const;
export const positionStates = ["planned", "working", "filled", "closed"] as const;
export const positionExitKinds = ["stop", "target"] as const;

export type PositionSide = (typeof positionSides)[number];
export type PositionState = (typeof positionStates)[number];

/** The largest tick price either way; the API refuses beyond it too. */
export const maxPositionTicks = 1_000_000_000;

/** A price on the tick grid: a whole number of ticks, negative allowed, within the bound. */
const ticks = z.number().int().min(-maxPositionTicks).max(maxPositionTicks);
const quantity = z.number().int().min(1).max(maxPositionQuantity);
const timeMs = z.number().int().positive();

const targetSchema = z.object({ priceTicks: ticks, quantity });
// `riskTicks` is the entry-to-stop distance as it stood at the fill, the basis of R (D-59). Fills saved before it have none.
const fillSchema = z.object({ timeMs, priceTicks: ticks, riskTicks: z.number().int().min(1).max(maxPositionTicks).nullish() });
const exitSchema = z.object({ timeMs, priceTicks: ticks, quantity: z.number().int().min(1), kind: z.enum(positionExitKinds) });

export const positionSchema = z
  .object({
    side: z.enum(positionSides),
    entryType: z.enum(positionEntryTypes),
    entryTicks: ticks.nullish(),
    quantity,
    stopTicks: ticks,
    targets: z.array(targetSchema).max(maxPositionTargets).default(() => []),
    contractId: z.string().trim().min(1).max(32),
    createdMs: timeMs,
    state: z.enum(positionStates).default("planned"),
    fill: fillSchema.nullish(),
    exits: z.array(exitSchema).default(() => []),
  })
  .superRefine((position, context) => {
    const entry = position.entryTicks;
    if (position.entryType === "limit" && (entry === null || entry === undefined)) {
      context.addIssue({ code: "custom", path: ["entryTicks"], message: "a limit entry needs its price" });
    }
    const isLong = position.side === "long";
    if (entry !== null && entry !== undefined) {
      if (isLong ? position.stopTicks >= entry : position.stopTicks <= entry) {
        context.addIssue({ code: "custom", path: ["stopTicks"], message: `the stop must be ${isLong ? "below" : "above"} the entry` });
      }
      position.targets.forEach((target, index) => {
        if (isLong ? target.priceTicks <= entry : target.priceTicks >= entry) {
          context.addIssue({ code: "custom", path: ["targets", index, "priceTicks"], message: `a target must be ${isLong ? "above" : "below"} the entry` });
        }
      });
    }
    if (entry === null || entry === undefined) {
      // A market entry with no price: each target must still be beyond the stop.
      position.targets.forEach((target, index) => {
        if (isLong ? target.priceTicks <= position.stopTicks : target.priceTicks >= position.stopTicks) {
          context.addIssue({ code: "custom", path: ["targets", index, "priceTicks"], message: `a target must be ${isLong ? "above" : "below"} the stop` });
        }
      });
    }
    if (position.targets.reduce((sum, target) => sum + target.quantity, 0) > position.quantity) {
      context.addIssue({ code: "custom", path: ["targets"], message: "target quantities exceed the position quantity" });
    }
    const filled = position.state === "filled" || position.state === "closed";
    if (filled !== (position.fill !== null && position.fill !== undefined)) {
      context.addIssue({ code: "custom", path: ["fill"], message: filled ? "a filled position needs its fill" : "only a filled position has a fill" });
    }
    if (!filled && position.exits.length > 0) {
      context.addIssue({ code: "custom", path: ["exits"], message: "only a filled position has exits" });
    }
    if (position.exits.reduce((sum, exit) => sum + exit.quantity, 0) > position.quantity) {
      context.addIssue({ code: "custom", path: ["exits"], message: "exit quantities exceed the position quantity" });
    }
  });

export type Position = z.infer<typeof positionSchema>;

const rootKey = z.string().regex(/^[A-Z0-9]{1,6}$/);

/** The positions map read leniently: a position or key the API would refuse is dropped, the rest are kept. */
export const positionsSchema = z.record(z.string(), z.unknown()).transform((entries) => {
  const kept: Record<string, Position> = {};
  for (const [root, value] of Object.entries(entries)) {
    const position = positionSchema.safeParse(value);
    if (rootKey.safeParse(root).success && position.success) kept[root] = position.data;
  }
  return kept;
});

/** The positions map for a stored layout: any invalid entry fails the parse. */
export const storedPositionsSchema = z.record(rootKey, positionSchema);
