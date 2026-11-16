import { useId, type ReactNode } from "react";

/** Whether a side-column section is folded, and how to flip it. Absent, the section cannot fold. */
export interface SideFold {
  readonly collapsed: boolean;
  readonly onToggle: () => void;
}

/** Props of one side-column section. */
export interface SidePanelProps {
  /** The region's accessible name. */
  readonly label: string;
  /** The heading's content: its name and any read-only marks beside it. */
  readonly title: ReactNode;
  readonly className?: string;
  /** A control beside the heading that belongs to the body, folded with it. */
  readonly headControl?: ReactNode;
  readonly fold?: SideFold;
  readonly children: ReactNode;
}

/**
 * One Detail side-column section (ARCHITECTURE.md D-45, D-49). With a fold, its heading is a button that folds the
 * body away and keeps the heading in place; the body stays mounted, so what the panel computes is unchanged.
 */
export function SidePanel({ label, title, className, headControl, fold, children }: SidePanelProps) {
  const bodyId = `${useId()}-body`;
  const collapsed = fold?.collapsed ?? false;
  const heading = (
    <h2 className="ld-panel-title">
      {fold ? (
        <button type="button" className="ld-fold" aria-expanded={!collapsed} aria-controls={bodyId} onClick={fold.onToggle}>
          <span className="ld-fold-mark" aria-hidden="true">
            {collapsed ? "▸" : "▾"}
          </span>
          <span className="ld-fold-title">{title}</span>
        </button>
      ) : (
        title
      )}
    </h2>
  );
  return (
    <section className={["ld-panel", className, collapsed ? "collapsed" : undefined].filter(Boolean).join(" ")} aria-label={label}>
      {headControl === undefined ? (
        heading
      ) : (
        <div className="panel-head">
          {heading}
          {!collapsed && headControl}
        </div>
      )}
      <div id={bodyId} className="ld-panel-body" hidden={collapsed}>
        {children}
      </div>
    </section>
  );
}
