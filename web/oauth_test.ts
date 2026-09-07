// The popup-return predicate (web/oauth.ts): what makes a page load a
// returning OAuth ceremony rather than an ordinary one.

import { assertEquals } from "@std/assert";

import { popupReturn } from "./oauth.ts";

Deno.test("a code and a state together are a return", () => {
  assertEquals(popupReturn("?code=synthetic-code-1&state=abc123"), {
    code: "synthetic-code-1",
    state: "abc123",
  });
  // No leading `?`: `location.search` is empty-or-`?`-prefixed, but the
  // predicate must not depend on which.
  assertEquals(popupReturn("code=synthetic-code-1&state=abc123"), {
    code: "synthetic-code-1",
    state: "abc123",
  });
});

Deno.test("order and extra parameters do not matter", () => {
  assertEquals(
    popupReturn("?scope=drive.appdata&state=abc123&code=synthetic-code-1"),
    { code: "synthetic-code-1", state: "abc123" },
  );
});

Deno.test("percent-encoding is decoded once, by the parser", () => {
  assertEquals(popupReturn("?code=a%2Fb&state=c%3Dd"), {
    code: "a/b",
    state: "c=d",
  });
});

Deno.test("an ordinary page load is not a return", () => {
  for (const search of ["", "?", "?device=laptop"]) {
    assertEquals(popupReturn(search), undefined, search);
  }
});

Deno.test("a code with no state is not a return", () => {
  // `state` is what binds the code to the ceremony the kernel minted, so a
  // code arriving without one is unattributed and this page will not act
  // on it.
  assertEquals(popupReturn("?code=synthetic-code-1"), undefined);
  assertEquals(popupReturn("?code=synthetic-code-1&state="), undefined);
});

Deno.test("a state with no code is not a return", () => {
  assertEquals(popupReturn("?state=abc123"), undefined);
  assertEquals(popupReturn("?code=&state=abc123"), undefined);
});

Deno.test("a declined consent is not a return", () => {
  // The provider's own error arm: the popup carries no code, so it closes
  // with nothing to say and the opener resolves `none` — the same answer a
  // user who closed the window gets (internal.wit `shell.open-popup`).
  assertEquals(popupReturn("?error=access_denied&state=abc123"), undefined);
});
