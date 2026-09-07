// The popup-return predicate (web/oauth.ts): what makes a page load a
// returning OAuth ceremony rather than an ordinary one, and which of the
// two returns it is.

import { assertEquals } from "@std/assert";

import { popupReturn } from "./oauth.ts";

Deno.test("a code and a state together are a return", () => {
  assertEquals(popupReturn("?code=synthetic-code-1&state=abc123"), {
    kind: "code",
    code: "synthetic-code-1",
    state: "abc123",
  });
  // No leading `?`: `location.search` is empty-or-`?`-prefixed, but the
  // predicate must not depend on which.
  assertEquals(popupReturn("code=synthetic-code-1&state=abc123"), {
    kind: "code",
    code: "synthetic-code-1",
    state: "abc123",
  });
});

Deno.test("order and extra parameters do not matter", () => {
  assertEquals(
    popupReturn("?scope=drive.appdata&state=abc123&code=synthetic-code-1"),
    { kind: "code", code: "synthetic-code-1", state: "abc123" },
  );
});

Deno.test("percent-encoding is decoded once, by the parser", () => {
  assertEquals(popupReturn("?code=a%2Fb&state=c%3Dd"), {
    kind: "code",
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

Deno.test("a declined consent is a return, carrying its state", () => {
  // The provider's own error arm. RFC 6749 §4.1.2.1 echoes `state` on the
  // error redirect too, so a decline is attributable to one ceremony
  // exactly as a code is — and the waiting side can stop waiting at once
  // instead of sitting out its bound.
  assertEquals(popupReturn("?error=access_denied&state=abc123"), {
    kind: "declined",
    state: "abc123",
  });
});

Deno.test("an error with no state is not a return", () => {
  // Nothing to attribute the refusal to: this page cannot tell it from
  // another tab's ceremony, and an unattributed decline that settled the
  // wait would be a ceremony cancelled by a stranger.
  assertEquals(popupReturn("?error=access_denied"), undefined);
  assertEquals(popupReturn("?error=access_denied&state="), undefined);
});

Deno.test("an error beside a code is a decline", () => {
  // A redirect that says both is a contradiction the provider's own spec
  // does not define; web/oauth.ts believes the refusal.
  assertEquals(
    popupReturn("?error=access_denied&code=synthetic-code-1&state=abc123"),
    { kind: "declined", state: "abc123" },
  );
});
