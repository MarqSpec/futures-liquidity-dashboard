/** The dashboard's views: one product's charts, every product's summary, or the Order Flow layout. */
export const dashboardTabs = ["detail", "overview", "bookmap"] as const;
export type DashboardTab = (typeof dashboardTabs)[number];

/** The order of the view tab bar. Detail stays the default when the URL and storage name no tab. */
export const viewTabOrder = ["overview", "detail", "bookmap"] as const;

/** The URL query parameter that names the tab. */
export const tabParam = "tab";

/** The query value written for the Order Flow view. `bookmap` still resolves, so older links keep working. */
export const orderFlowParam = "orderflow";

/** Reads a tab name from the URL or storage; null for anything else. */
export function parseTab(value: unknown): DashboardTab | null {
  if (value === orderFlowParam || value === "bookmap") return "bookmap";
  return dashboardTabs.find((tab) => tab === value) ?? null;
}

/** The label on the view tab bar. The RIPS preset stays a control on the chart, not the tab name. */
export function viewTabLabel(tab: DashboardTab, instrument: string): string {
  if (tab === "overview") return "Overview";
  if (tab === "bookmap") return `Order Flow: ${instrument}`;
  return `Detail: ${instrument}`;
}

/** The tab to show: the URL's when it names one, else the one this browser last showed, else Detail. */
export function resolveTab(fromUrl: unknown, fromStorage: unknown): DashboardTab {
  return parseTab(fromUrl) ?? parseTab(fromStorage) ?? "detail";
}

/** The query string with `tab` set; Detail, the default, takes the parameter out. Other parameters are kept. */
export function withTabParam(params: URLSearchParams, tab: DashboardTab): URLSearchParams {
  const next = new URLSearchParams(params);
  if (tab === "detail") next.delete(tabParam);
  else if (tab === "bookmap") next.set(tabParam, orderFlowParam);
  else next.set(tabParam, tab);
  return next;
}
