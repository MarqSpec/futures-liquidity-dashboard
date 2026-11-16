import { createContext, useContext } from "react";

/** Opens the server form. Null in the browser, where that form is not shown. */
export const ChangeServerContext = createContext<(() => void) | null>(null);

/** The status bar calls this so the control sits in the bar instead of over the chart. */
export function useChangeServer(): (() => void) | null {
  return useContext(ChangeServerContext);
}
