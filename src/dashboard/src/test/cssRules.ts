// Reads index.css rules for the stylesheet tests.

/** Top-level rules of a stylesheet by selector, comments removed; at-rules are skipped. */
export function topLevelRules(source: string): Map<string, string> {
  const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, "");
  const rules = new Map<string, string>();
  let index = 0;
  while (index < withoutComments.length) {
    const open = withoutComments.indexOf("{", index);
    if (open < 0) {
      break;
    }
    const selector = withoutComments.slice(index, open).replace(/\s+/g, " ").trim();
    let depth = 1;
    let cursor = open + 1;
    while (cursor < withoutComments.length && depth > 0) {
      const character = withoutComments[cursor];
      if (character === "{") {
        depth += 1;
      } else if (character === "}") {
        depth -= 1;
      }
      cursor += 1;
    }
    if (depth !== 0) {
      break;
    }
    if (selector.length > 0 && !selector.startsWith("@")) {
      rules.set(selector, withoutComments.slice(open + 1, cursor - 1));
    }
    index = cursor;
  }
  return rules;
}

/** The value of `property` in a rule body, whitespace collapsed; undefined when it is not declared. */
export function declaration(body: string | undefined, property: string): string | undefined {
  if (!body) {
    return undefined;
  }
  const match = body.match(new RegExp(`(?:^|[;{}])\\s*${property}\\s*:\\s*([^;]+)`, "i"));
  return match?.[1]?.trim().replace(/\s+/g, " ");
}

/**
 * The value `property` resolves to for an element matched by exactly `selector`, across every top-level rule whose
 * selector list names it; the later rule wins.
 */
export function cascaded(rules: ReadonlyMap<string, string>, selector: string, property: string): string | undefined {
  let value: string | undefined;
  for (const [selectors, body] of rules) {
    if (selectors.split(",").some((candidate) => candidate.trim() === selector)) {
      value = declaration(body, property) ?? value;
    }
  }
  return value;
}
