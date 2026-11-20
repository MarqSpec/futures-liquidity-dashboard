import { readingText, type Condition } from "../domain/conditions.ts";
import { SidePanel, type SideFold } from "./SidePanel.tsx";

/** Props of the conditions panel. */
export interface ConditionsPanelProps {
  readonly conditions: readonly Condition[];
  readonly fold?: SideFold;
}

/**
 * The fixed conditions, one row each: the name, what it reads now, the inputs it compared and its definition
 * (REQUIREMENTS.md FR-81, ARCHITECTURE.md D-67). A warming, partial, stale or missing input reads as such, never as a state.
 */
export function ConditionsPanel({ conditions, fold }: ConditionsPanelProps) {
  return (
    <SidePanel label="Conditions" title="Conditions" fold={fold}>
      <ul className="ld-list ld-conditions">
        {conditions.map((condition) => (
          <li key={condition.id} className="ld-condition">
            <span className="name">{condition.name}</span>
            <span className="reading" data-reading={condition.reading.kind}>
              {readingText(condition.reading)}
            </span>
            <span className="value">{condition.value}</span>
            <span className="definition">{condition.definition}</span>
          </li>
        ))}
      </ul>
      <p className="ld-conditions-note" role="note">
        Each state describes closed bars or the current book by the rule beside it: no score, no forecast and no
        suggested action.
      </p>
    </SidePanel>
  );
}
