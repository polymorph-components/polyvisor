// The browser half of the storage OAuth ceremony, as far as it is a pure
// function (internal.wit `shell.open-popup`).
//
// The ceremony's two ends are in web/boot.ts: the opener, which opens the
// popup and waits, and the page loaded INSIDE that popup when the provider
// redirects back to this origin. Both ends turn on the same question — is
// this load a ceremony returning? — and that question is a string
// predicate, so it lives here where a test can pin it.

/** What the provider hands back on the redirect (internal.wit
 * `shell.open-popup`: "the `code` and `state` query parameters the popup
 * returns to this page's URL with"). */
export interface OAuthReturn {
  code: string;
  state: string;
}

/**
 * The ceremony's return, if this is one.
 *
 * `search` is `location.search` — leading `?` and all; `URLSearchParams`
 * accepts it either way. BOTH parameters are required and both must be
 * non-empty: `state` is what binds the returned code to the ceremony the
 * kernel minted, so a redirect carrying only a code is not a return this
 * page may act on — it is an unattributed code, and the honest answer is
 * that this is an ordinary page load.
 *
 * An `error` parameter (the user declining consent, a provider refusal) is
 * likewise "not a return": the popup closes with no message and the opener
 * resolves `none`, which is exactly the shape internal.wit gives a user
 * who closed the window. There is nothing else the visor could do with a
 * provider's error string, and passing one through would make the kernel
 * exchange a code it never got.
 */
export function popupReturn(search: string): OAuthReturn | undefined {
  const params = new URLSearchParams(search);
  const code = params.get("code") ?? "";
  const state = params.get("state") ?? "";
  if (code === "" || state === "") return undefined;
  return { code, state };
}
