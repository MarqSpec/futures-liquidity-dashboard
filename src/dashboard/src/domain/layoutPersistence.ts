import { z } from "zod";

import { acceptStoredLayout, layoutSchema, storedLayoutSchema, type LayoutSettings } from "./layout.ts";

/** A layout kept in this browser. `revision` is the server counter it was based on, and `pending` is an edit not yet acknowledged. */
export interface StoredLayout {
  readonly revision: number;
  readonly layout: LayoutSettings;
  readonly pending: boolean;
}

/** GET and PUT /api/layouts/me. `saved` is false when the store has nothing for the caller: never saved, or its file was lost. */
export const layoutDocumentSchema = z.object({
  saved: z.boolean(),
  revision: z.number().int().nonnegative(),
  layout: layoutSchema,
});

export type ServerLayout = z.infer<typeof layoutDocumentSchema>;

/** Which layout to show, and whether it should be PUT because the server is missing it or this browser still has that revision unsent. */
export interface LayoutChoice {
  readonly layout: LayoutSettings;
  readonly revision: number;
  readonly push: boolean;
}

const storedDocumentSchema = z.object({
  revision: z
    .number()
    .int()
    .nonnegative()
    .refine((value) => Number.isSafeInteger(value)),
  layout: storedLayoutSchema,
  pending: z.boolean().optional().default(false),
});

/**
 * Reads a stored layout. A document written by this client is `{ revision, layout, pending }`. An older client
 * stored the layout itself. A document that does not match the schema is ignored, so a corrupt copy cannot be
 * saved back as the defaults.
 */
export function readStoredLayout(value: unknown): StoredLayout | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  if ("layout" in record || "revision" in record || "pending" in record) {
    const parsed = storedDocumentSchema.safeParse(value);
    if (!parsed.success) {
      return null;
    }
    return { revision: parsed.data.revision, layout: parsed.data.layout, pending: parsed.data.pending };
  }
  const layout = acceptStoredLayout(value);
  if (!layout) {
    return null;
  }
  return { revision: 0, layout, pending: false };
}

/**
 * Picks the layout to use after a restart or a second browser. The server copy wins whenever it was saved,
 * except for an edit this browser has not had acknowledged at that same revision. An empty store (`saved` false)
 * sends the local document only when it parsed, citing the server's current revision.
 */
export function reconcileLayout(local: StoredLayout | null, server: ServerLayout): LayoutChoice {
  if (!server.saved) {
    if (local) {
      return { layout: local.layout, revision: server.revision, push: true };
    }
    return { layout: server.layout, revision: server.revision, push: false };
  }
  if (local?.pending && local.revision === server.revision) {
    return { layout: local.layout, revision: server.revision, push: true };
  }
  return { layout: server.layout, revision: server.revision, push: false };
}
