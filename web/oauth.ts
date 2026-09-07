// The browser half of the storage OAuth ceremony, as far as it is a pure
// function (internal.wit `shell.open-popup`).
//
// The ceremony's two ends are in web/boot.ts: the waiting side, which opens
// the popup and listens on the ceremony's BroadcastChannel, and the page
// loaded INSIDE that popup when the provider redirects back to this origin.
// Both ends turn on the same question — is this load a ceremony returning,
// and with what? — and that question is a string predicate, so it lives
// here where a test can pin it.

/** What the provider hands back on the redirect (internal.wit
 * `shell.open-popup`: "the `code` and `state` query parameters the popup
 * returns to this page's URL with"), or the user's refusal.
 *
 * Two arms, not one plus `undefined`, because a decline is a fact the
 * waiting side can act on — it carries the `state` that says WHICH ceremony
 * was declined, so the answer is attributable exactly as a code is. "Not a
 * return at all" is the `undefined` that `popupReturn` may answer instead. */
export type OAuthReturn =
  | { kind: "code"; code: string; state: string }
  | { kind: "declined"; state: string };

/**
 * The ceremony's return, if this is one.
 *
 * `search` is `location.search` — leading `?` and all; `URLSearchParams`
 * accepts it either way.
 *
 * `state` is required in BOTH arms, and both parameters are required in the
 * code arm: `state` is what binds what came back to the ceremony the kernel
 * minted, so a redirect carrying only a code is not a return this page may
 * act on — it is an unattributed code, and the honest answer is that this is
 * an ordinary page load. An `error` with no `state` is the same shape from
 * the other side: there is nothing to attribute the refusal to, and the
 * waiting side would have no way to tell it from another tab's ceremony.
 *
 * `error` (the user declining consent, a provider refusal) with a `state` is
 * the `declined` arm. RFC 6749 §4.1.2.1 has the error redirect echo `state`
 * exactly as the success one does, which is what makes that arm possible at
 * all. The waiting side resolves `none` for it — the same answer internal.wit
 * gives a ceremony that never came back — but resolves it AT ONCE rather
 * than after the bound, which is the whole reason the arm exists.
 */
export function popupReturn(search: string): OAuthReturn | undefined {
  const params = new URLSearchParams(search);
  const code = params.get("code") ?? "";
  const state = params.get("state") ?? "";
  const error = params.get("error") ?? "";
  if (state === "") return undefined;
  // CONTRACT: RFC 6749 §4.1.2 gives the authorization response one arm or
  // the other and says nothing about a redirect carrying both. The
  // conservative reading is that a present `error` is the provider refusing,
  // so it wins: exchanging a code the same redirect called an error would be
  // this page deciding which half of a contradiction to believe.
  if (error !== "") return { kind: "declined", state };
  if (code !== "") return { kind: "code", code, state };
  return undefined;
}
