import type { ShouldRevalidateFunctionArgs } from "react-router";

import { getInstruments } from "../api/client.ts";
import type { InstrumentSummary } from "../api/schemas.ts";
import { tabParam } from "../domain/tabs.ts";

/** The instruments this viewer may see; an empty list when the API cannot say, so the page still renders. */
export async function dashboardLoader({ request }: { readonly request: Request }): Promise<InstrumentSummary[]> {
  try {
    return await getInstruments(request.signal);
  } catch {
    return [];
  }
}

/**
 * Re-reads the instruments on a navigation unless it only switched the tab: the dashboard polls them itself, and a
 * tab change must not wait on (or flash a loading state for) a fresh read.
 */
export function dashboardShouldRevalidate({ currentUrl, nextUrl, defaultShouldRevalidate }: ShouldRevalidateFunctionArgs): boolean {
  return withoutTab(currentUrl) === withoutTab(nextUrl) ? false : defaultShouldRevalidate;
}

function withoutTab(url: URL): string {
  const params = new URLSearchParams(url.search);
  params.delete(tabParam);
  params.sort();
  return `${url.pathname}?${params.toString()}`;
}
