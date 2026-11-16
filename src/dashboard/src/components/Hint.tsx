import { useEffect, useId, useState, type FocusEventHandler, type MouseEventHandler, type ReactNode, type RefCallback } from "react";

// An accessible hint for one control: a sentence shown on hover and on keyboard focus, and on touch through a small
// info button beside the control. The control references the sentence with aria-describedby, so a screen reader reads
// it with the control's name. Escape, blur and the pointer leaving hide it. It uses no native title (ARCHITECTURE.md
// D-47).

/** What a hinted element spreads onto itself. */
export interface HintTarget {
  readonly ref: RefCallback<HTMLElement>;
  readonly "aria-describedby": string;
  readonly onMouseEnter: MouseEventHandler<HTMLElement>;
  readonly onMouseLeave: MouseEventHandler<HTMLElement>;
  readonly onFocus: FocusEventHandler<HTMLElement>;
  readonly onBlur: FocusEventHandler<HTMLElement>;
}

/** Props of a hint. */
export interface HintProps {
  /** The one sentence, from `domain/hints.ts`. */
  readonly text: string;
  /** The control's name, which names the touch toggle ("Explain Flow"). */
  readonly label: string;
  /** Renders the control with the target props spread onto it. A group (a fieldset) may be the target. */
  readonly children: (target: HintTarget) => ReactNode;
}

const TIP_WIDTH = 260;
const EDGE = 8;

/**
 * Renders the control, then a layout-neutral sibling holding the touch toggle and the hint. The hint is fixed to the
 * viewport under the control, so no ancestor clips it and no joined button group is split by it.
 */
export function Hint({ text, label, children }: HintProps) {
  const id = useId();
  const [target, setTarget] = useState<HTMLElement | null>(null);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [toggled, setToggled] = useState(false);
  const [place, setPlace] = useState({ left: EDGE, top: 0 });
  const open = hovered || focused || toggled;

  // The hint sits under the control as it is when the hint opens. It hides on any scroll or resize while open, so it
  // is never left detached from its control.
  const measure = (element: HTMLElement | null) => {
    if (!element) return;
    const rect = element.getBoundingClientRect();
    const left = Math.max(EDGE, Math.min(rect.left, window.innerWidth - TIP_WIDTH - EDGE));
    setPlace({ left, top: rect.bottom + 4 });
  };

  useEffect(() => {
    if (!open) return;
    const close = () => {
      setHovered(false);
      setFocused(false);
      setToggled(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [open]);

  const props: HintTarget = {
    ref: setTarget,
    "aria-describedby": id,
    onMouseEnter: (event) => {
      measure(event.currentTarget);
      setHovered(true);
    },
    onMouseLeave: () => setHovered(false),
    onFocus: (event) => {
      measure(event.currentTarget);
      setFocused(true);
    },
    onBlur: () => {
      setFocused(false);
      setToggled(false);
    },
  };

  return (
    <>
      {children(props)}
      <span className="hint">
        <button
          type="button"
          className="hint-toggle"
          aria-label={`Explain ${label}`}
          aria-expanded={toggled}
          aria-controls={id}
          onClick={() => {
            measure(target);
            setToggled((on) => !on);
          }}
          onBlur={() => setToggled(false)}
        >
          ⓘ
        </button>
        <span className="hint-tip" role="tooltip" id={id} hidden={!open} style={{ left: place.left, top: place.top }}>
          {text}
        </span>
      </span>
    </>
  );
}
