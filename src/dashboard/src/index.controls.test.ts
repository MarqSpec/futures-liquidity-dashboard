import { describe, expect, it } from "vitest";

import css from "./index.css?raw";

// The control rules of the design system: buttons in four emphases with a state layer, a focus ring, joined groups,
// fields and selects, toggles and icon buttons. Each is read from the stylesheet by selector.

const stripped = css.replace(/\/\*[\s\S]*?\*\//g, "");

/** Splits a selector list on the commas that are not inside brackets or parentheses. */
function splitList(list: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const character of list) {
    if (character === "(" || character === "[") depth += 1;
    if (character === ")" || character === "]") depth -= 1;
    if (character === "," && depth === 0) {
      parts.push(current.replace(/\s+/g, " ").trim());
      current = "";
    } else {
      current += character;
    }
  }
  parts.push(current.replace(/\s+/g, " ").trim());
  return parts;
}

/** Every declaration block whose selector list contains `selector` exactly, in order. */
function blocks(selector: string): string[] {
  const found: string[] = [];
  for (const match of stripped.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const list = splitList(match[1] ?? "");
    if (list.includes(selector)) {
      found.push(match[2] ?? "");
    }
  }
  return found;
}

function has(selector: string, declaration: string): boolean {
  const wanted = declaration.replace(/\s+/g, " ").trim();
  return blocks(selector).some((body) => body.replace(/\s+/g, " ").includes(wanted));
}

/** Specificity [ids, classes, elements] of one selector: `:where()` counts nothing, `:not()` counts its heaviest argument. */
function specificity(selector: string): [number, number, number] {
  let rest = selector;
  const total: [number, number, number] = [0, 0, 0];
  const add = (part: [number, number, number]) => {
    total[0] += part[0];
    total[1] += part[1];
    total[2] += part[2];
  };
  for (;;) {
    const open = rest.search(/:(where|not|is)\(/);
    if (open < 0) break;
    const name = /:(where|not|is)\(/.exec(rest.slice(open))?.[1] ?? "";
    const start = open + name.length + 2;
    let depth = 1;
    let end = start;
    while (end < rest.length && depth > 0) {
      depth += rest[end] === "(" ? 1 : rest[end] === ")" ? -1 : 0;
      end += 1;
    }
    const inner = splitList(rest.slice(start, end - 1));
    if (name !== "where") {
      add(inner.map((part) => specificity(part.trim())).reduce((best, next) => (next[1] > best[1] || (next[1] === best[1] && next[2] > best[2]) ? next : best)));
    }
    rest = rest.slice(0, open) + " " + rest.slice(end);
  }
  total[0] += (rest.match(/#[\w-]+/g) ?? []).length;
  total[1] += (rest.match(/\.[\w-]+|\[[^\]]*\]|(?<!:):(?!:)[\w-]+/g) ?? []).length;
  total[2] += (rest.replace(/\[[^\]]*\]/g, "").match(/(?:^|[\s>+~])[a-z][\w-]*|::[\w-]+/gi) ?? []).length;
  return total;
}

function compare(a: readonly number[], b: readonly number[]): number {
  return (a[0] ?? 0) - (b[0] ?? 0) || (a[1] ?? 0) - (b[1] ?? 0) || (a[2] ?? 0) - (b[2] ?? 0);
}

/** True when the rule for `selector` that sets `property` beats every rule for `base` that sets it, by specificity then order. */
function winsOver(selector: string, property: string, base: string): boolean {
  const rules: { list: string[]; body: string; index: number }[] = [];
  for (const match of stripped.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    rules.push({ list: splitList(match[1] ?? ""), body: match[2] ?? "", index: match.index ?? 0 });
  }
  const sets = (body: string) => new RegExp(String.raw`(?:^|[;\s])(?:${property}|${property.split("-")[0]})\s*:`).test(body);
  const mine = rules.filter((rule) => rule.list.includes(selector) && sets(rule.body));
  const theirs = rules.filter((rule) => rule.list.includes(base) && sets(rule.body));
  const own = mine[mine.length - 1];
  if (!own || theirs.length === 0) return false;
  return theirs.every((other) => compare(specificity(selector), specificity(base)) > 0 || (compare(specificity(selector), specificity(base)) === 0 && own.index > other.index));
}

describe("specificity", () => {
  it("should count :where as nothing and :not as its heaviest argument when a selector is measured", () => {
    expect([specificity('input:where(:not([type="a"], [type="b"]))'), specificity('input:not([type="a"]):not([type="b"])'), specificity(".key-gate input")]).toEqual([
      [0, 0, 1],
      [0, 2, 1],
      [0, 1, 1],
    ]);
  });
});

describe("index.css buttons", () => {
  it("should size a button at the control height with the small radius when no class is set", () => {
    expect([has("button", "height: var(--control-height)"), has("button", "border-radius: var(--radius-sm)")]).toEqual([true, true]);
  });

  it("should draw the outlined emphasis by default when a button has no class", () => {
    expect([
      has("button", "background: var(--surface-high)"),
      has("button", "border: 1px solid var(--outline)"),
      has("button", "color: var(--on-surface)"),
    ]).toEqual([true, true, true]);
  });

  it("should fill primary when the button is the filled emphasis", () => {
    expect([has("button.filled", "background: var(--primary)"), has("button.filled", "color: var(--on-primary)")]).toEqual([true, true]);
  });

  it("should use the container pair when the button is tonal or pressed or selected", () => {
    const selectors = ["button.tonal", 'button[aria-pressed="true"]', 'button[aria-selected="true"]'];

    expect(selectors.map((s) => has(s, "background: var(--primary-container)") && has(s, "color: var(--on-primary-container)"))).toEqual([
      true,
      true,
      true,
    ]);
  });

  it("should show primary text with no border when the button is the text emphasis", () => {
    expect([
      has("button.text", "color: var(--primary)"),
      has("button.text", "background: transparent"),
      has("button.text", "border-color: transparent"),
    ]).toEqual([true, true, true]);
  });

  it("should shrink to the small control height at 11px when the button is small", () => {
    expect([has("button.small", "height: var(--control-height-sm)"), has("button.small", "font-size: 11px")]).toEqual([true, true]);
  });

  it("should lay the hover and pressed state layers and turn the border primary when a button is hovered or pressed", () => {
    expect([
      has("button:hover::before", "background: var(--state-hover)"),
      has("button:active::before", "background: var(--state-pressed)"),
      has("button:hover", "border-color: var(--primary)"),
    ]).toEqual([true, true, true]);
  });

  it("should drop to the disabled opacity with no state layer when a button is disabled", () => {
    expect([
      has("button:disabled", "opacity: var(--opacity-disabled)"),
      has("button:disabled::before", "background: transparent"),
      has("button:disabled", "cursor: not-allowed"),
    ]).toEqual([true, true, true]);
  });

  it("should be transparent and muted, and last-price when pressed, when the button is an icon button", () => {
    expect([
      has("button.icon-button", "color: var(--on-surface-muted)"),
      has("button.icon-button", "background: transparent"),
      has('button.icon-button[aria-pressed="true"]', "color: var(--last-price)"),
      has("button.icon-button", "width: var(--control-height)"),
    ]).toEqual([true, true, true, true]);
  });
});

describe("index.css filled buttons", () => {
  const pressed = 'button[aria-pressed="true"]';
  const filledPressed = 'button.filled[aria-pressed="true"]';

  it("should stay primary with its own text colour when a filled button is pressed, as Live is while following", () => {
    expect([
      has(filledPressed, "background: var(--primary)"),
      has(filledPressed, "color: var(--on-primary)"),
      winsOver(filledPressed, "background", pressed),
      winsOver(filledPressed, "color", pressed),
      blocks(filledPressed).map((body) => body.replace(/\s+/g, " ").trim()),
    ]).toEqual([true, true, true, true, ["background: var(--primary); border-color: var(--primary); color: var(--on-primary);"]]);
  });
});

describe("index.css focus", () => {
  it("should draw a solid 2px primary ring one pixel outside when a control takes keyboard focus", () => {
    expect([has(":focus-visible", "outline: 2px solid var(--primary)"), has(":focus-visible", "outline-offset: 1px")]).toEqual([true, true]);
  });

  it("should inset the ring two pixels when the focus is on a chart surface", () => {
    expect([has(".chart-surface:focus-visible", "outline: 2px solid var(--primary)"), has(".chart-surface:focus-visible", "outline-offset: -2px")]).toEqual([
      true,
      true,
    ]);
  });

  it("should never remove an outline when a rule styles a control", () => {
    expect(stripped.match(/outline\s*:\s*(?:none|0)\b/g) ?? []).toEqual([]);
  });
});

describe("index.css button groups", () => {
  it("should join the buttons of a group so the outer corners alone are rounded when a segmented fieldset renders", () => {
    expect([
      has(".segmented button", "border-radius: 0"),
      has(".segmented button", "margin-left: -1px"),
      has(".segmented button:first-of-type", "border-radius: var(--radius-sm) 0 0 var(--radius-sm)"),
      has(".segmented button:last-of-type", "border-radius: 0 var(--radius-sm) var(--radius-sm) 0"),
    ]).toEqual([true, true, true, true]);
  });

  it("should join the Bookmap fieldsets the same way when the toolbar renders", () => {
    expect([
      has(".bookmap-controls fieldset button", "border-radius: 0"),
      has(".bookmap-controls fieldset button:first-of-type", "border-radius: var(--radius-sm) 0 0 var(--radius-sm)"),
    ]).toEqual([true, true]);
  });

  it("should join Detail's price buttons the way Order Flow's are and keep the strip its own height when it renders", () => {
    expect([
      has(".chart-price-controls", "flex: none"),
      has(".chart-price-controls button", "height: var(--control-height-sm)"),
      has(".chart-price-controls button", "border-radius: 0"),
      has(".chart-price-controls button", "margin-left: -1px"),
      has(".chart-price-controls button:first-of-type", "border-radius: var(--radius-sm) 0 0 var(--radius-sm)"),
      has(".chart-price-controls button:last-of-type", "border-radius: 0 var(--radius-sm) var(--radius-sm) 0"),
      has('.chart-price-controls button[aria-pressed="true"]', "z-index: 1"),
    ]).toEqual([true, true, true, true, true, true, true]);
  });

  it("should set Detail's Main chart group apart from the Price group and wrap them on a narrow screen", () => {
    expect([
      has(".chart-price-controls", "gap: var(--space-4) var(--space-12)"),
      has(".chart-price-controls", "flex-wrap: wrap"),
    ]).toEqual([true, true]);
  });

  it("should lift the chosen button over its neighbours so its border is not covered when it is pressed", () => {
    expect(has('.segmented button[aria-pressed="true"]', "z-index: 1")).toBe(true);
  });
});

describe("index.css fields", () => {
  const fields = 'input:where(:not([type="checkbox"], [type="radio"], [type="range"]))';

  it("should size text fields and selects at the control height on the high surface when they render", () => {
    expect([
      has(fields, "height: var(--control-height)"),
      has(fields, "background: var(--surface-high)"),
      has(fields, "border: 1px solid var(--outline)"),
      has("select", "height: var(--control-height)"),
      has("select", "border: 1px solid var(--outline)"),
    ]).toEqual([true, true, true, true, true]);
  });

  it("should mute the placeholder when a field is empty", () => {
    expect(has(`${fields}::placeholder`, "color: var(--on-surface-muted)")).toBe(true);
  });

  it("should mute the border on hover and turn it primary with a ring on focus", () => {
    expect([
      has(`${fields}:hover`, "border-color: var(--on-surface-muted)"),
      has(`${fields}:focus-visible`, "border-color: var(--primary)"),
      has(`${fields}:focus-visible`, "outline: 2px solid var(--primary)"),
      has("select:focus-visible", "border-color: var(--primary)"),
    ]).toEqual([true, true, true, true]);
  });

  it("should draw the help line in the error colour when it reports a problem", () => {
    expect([has(".field-help", "color: var(--on-surface-muted)"), has(".field-help.field-help-error", "color: var(--error)")]).toEqual([true, true]);
  });

  it("should keep the server URL and API key fields at the larger 32px size when the base field rule is weaker", () => {
    expect([
      winsOver(".key-gate input", "height", fields),
      winsOver('.server-url-card input[type="url"]', "height", fields),
      has(".key-gate input", "height: 32px"),
      has('.server-url-card input[type="url"]', "height: 32px"),
    ]).toEqual([true, true, true, true]);
  });

  it("should draw the error border over the base, hover and focus rules when the field is invalid", () => {
    expect([
      has('input[aria-invalid="true"]', "border-color: var(--error)"),
      winsOver('input[aria-invalid="true"]', "border-color", fields),
      winsOver('input[aria-invalid="true"]', "border-color", `${fields}:hover`),
      winsOver('input[aria-invalid="true"]', "border-color", `${fields}:focus-visible`),
    ]).toEqual([true, true, true, true]);
  });
});

describe("index.css toggles", () => {
  it("should tint a checkbox with the primary colour when it renders", () => {
    expect(has(".toggle input", "accent-color: var(--primary)")).toBe(true);
  });

  it("should draw a 10 by 2 pixel swatch when a layer shows its own colour", () => {
    expect([has(".toggle-swatch", "width: 10px"), has(".toggle-swatch", "height: 2px")]).toEqual([true, true]);
  });
});

describe("index.css icon buttons", () => {
  it("should draw a disabled icon button with no border when the watchlist is full", () => {
    expect([has("button.icon-button:disabled", "border-color: transparent"), winsOver("button.icon-button:disabled", "border-color", "button:disabled")]).toEqual([
      true,
      true,
    ]);
  });

  it("should leave the star's own rules to what an icon button does not do when it renders", () => {
    expect(blocks(".star")).toEqual([]);
  });
});

describe("index.css aligned buttons", () => {
  // The base button is a flex box, where text-align does nothing: alignment is justify-content.
  it.each([
    [".overview-table .sort", "flex-end"],
    [".overview-table th:nth-child(2) .sort", "flex-start"],
    [".products-table .select", "flex-start"],
    [".favorites-toggle", "flex-start"],
  ])("should align the content of %s with %s when the button fills its cell", (selector, value) => {
    expect(has(selector, `justify-content: ${value}`)).toBe(true);
  });

  it("should give every left or right aligned button rule a matching justify-content when text-align is set", () => {
    const wrong: string[] = [];
    for (const match of stripped.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const body = match[2] ?? "";
      const align = /text-align:\s*(left|right)/.exec(body)?.[1];
      const selector = (match[1] ?? "").replace(/\s+/g, " ").trim();
      if (!align || !/(^|[\s,])(?:[\w.:-]*\.(?:select|sort)|button|[\w.-]*button\b)/.test(selector) || /display:\s*grid/.test(body)) continue;
      const justify = /justify-content:\s*([\w-]+)/.exec(body)?.[1];
      const wanted = align === "left" ? "flex-start" : "flex-end";
      if (justify !== wanted && justify !== "space-between") wrong.push(selector);
    }
    expect(wrong).toEqual([]);
  });
});
