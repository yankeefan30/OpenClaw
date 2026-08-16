/**
 * The complete Grok Companions selector contract.
 *
 * xAI does not currently document a Grok Companions web surface. These are
 * deliberately accessibility-first capability probes, not reverse-engineered
 * CSS selectors. The worker must observe both exact visible labels before it
 * is allowed to submit a prompt. Selector drift is therefore fail-closed.
 */
export const GROK_COMPANIONS_SELECTORS = Object.freeze({
  loggedIn: Object.freeze([
    Object.freeze({ kind: "role", role: "textbox", name: /ask grok|message grok/i }),
    Object.freeze({ kind: "testId", value: "grok-composer" }),
  ]),
  companionsNavigation: Object.freeze([
    Object.freeze({ kind: "role", role: "link", name: "Companions", exact: true }),
    Object.freeze({ kind: "role", role: "button", name: "Companions", exact: true }),
    Object.freeze({ kind: "text", value: "Companions", exact: true }),
  ]),
  badRudyChoice: Object.freeze([
    Object.freeze({ kind: "role", role: "button", name: "Bad Rudy", exact: true }),
    Object.freeze({ kind: "role", role: "option", name: "Bad Rudy", exact: true }),
    Object.freeze({ kind: "text", value: "Bad Rudy", exact: true }),
  ]),
  badRudySelected: Object.freeze([
    Object.freeze({ kind: "role", role: "heading", name: "Bad Rudy", exact: true }),
    Object.freeze({ kind: "attribute", selector: "[aria-selected='true']", text: "Bad Rudy" }),
    Object.freeze({ kind: "attribute", selector: "[data-state='active']", text: "Bad Rudy" }),
  ]),
  promptInput: Object.freeze([
    Object.freeze({ kind: "role", role: "textbox", name: /what should bad rudy|message bad rudy|prompt/i }),
    Object.freeze({ kind: "placeholder", value: /what should bad rudy|message bad rudy|prompt/i }),
  ]),
  submit: Object.freeze([
    Object.freeze({ kind: "role", role: "button", name: /generate|create|send/i }),
  ]),
  renderDone: Object.freeze([
    Object.freeze({ kind: "role", role: "button", name: /download|save video/i }),
    Object.freeze({ kind: "text", value: /video (is )?ready|completed|done/i }),
  ]),
  renderedVideo: Object.freeze([
    Object.freeze({ kind: "css", value: "video" }),
  ]),
});

export type SelectorSpec =
  | { readonly kind: "role"; readonly role: string; readonly name: string | RegExp; readonly exact?: boolean }
  | { readonly kind: "testId"; readonly value: string }
  | { readonly kind: "text"; readonly value: string | RegExp; readonly exact?: boolean }
  | { readonly kind: "placeholder"; readonly value: string | RegExp }
  | { readonly kind: "attribute"; readonly selector: string; readonly text: string }
  | { readonly kind: "css"; readonly value: string };
