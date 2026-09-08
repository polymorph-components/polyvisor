// Where the keyboard goes, when the visor says so.
//
// The visor is a stream-dom producer and cannot move focus itself: the
// pinned receiver's `MountedData` is `()` with `set_focus` unsupported. So
// the visor states its intent in markup and this module carries it out.
// Two attributes, both written by visor/src/ui.rs:
//
//   * `data-visor-focus` on at most one element, valued with a generation
//     number that advances only when the visor itself caused a transition
//     worth moving the caret for. Anything else re-renders with the same
//     number and moves nothing.
//   * `data-visor-app-inert` on `#visor-root`, mirrored onto `#app-zone` —
//     the app zone is the page's element, not the visor's tree, so the
//     visor cannot mark it itself, and something has to or Tab walks out of
//     an open drawer into the app under the scrim.
//
// `inert` is a presence attribute (`inert="false"` is still inert), hence
// `toggleAttribute` rather than a stringified boolean.

/**
 * Serve the visor's focus requests for as long as the page lives. `visor` is
 * the element the producer is mounted into, `appZone` the one app frames go
 * into.
 */
export function attachVisorFocus(
  visor: HTMLElement,
  appZone: HTMLElement,
): void {
  /** The last generation served — advanced even when the move below is
   * declined, because a request is spent when it is made. Deferring one
   * would fire it later, on an unrelated commit, which is the focus theft
   * this avoids. */
  let lastGen = -1;
  /** Was the dialog up at the previous commit? Distinct from
   * `beforeDialog === null`, which is also "it was up, and the caret was not
   * ours to remember". */
  let dialogUp = false;
  let beforeDialog: HTMLElement | null = null;

  /** Still on the page and not inside something inert — `focus()` on an
   * inert element silently does nothing. */
  const reachable = (el: HTMLElement | null): el is HTMLElement =>
    el !== null && el.isConnected && el.closest("[inert]") === null;

  /** Is the caret the visor's to move? It is not when it sits in an app's
   * frame: a drawer opening because a session ended elsewhere must not
   * reach in and take it. */
  const ours = (): boolean => {
    const active = document.activeElement;
    return active === null || active === document.body ||
      visor.contains(active);
  };

  // `preventScroll`: the target is already on screen, and scrolling the page
  // to it would move the strip, which is the one thing that does not move.
  const put = (el: HTMLElement) => el.focus({ preventScroll: true });

  function settle(): void {
    const root = visor.querySelector("#visor-root");
    appZone.toggleAttribute(
      "inert",
      root?.hasAttribute("data-visor-app-inert") ?? false,
    );

    const dialog = visor.querySelector<HTMLElement>("#visor-confirm");
    if (dialog !== null && !dialogUp) {
      dialogUp = true;
      const active = document.activeElement;
      beforeDialog = active instanceof HTMLElement && visor.contains(active)
        ? active
        : null;
    }

    let moved = false;
    const target = visor.querySelector<HTMLElement>("[data-visor-focus]");
    const gen = target === null ? Number.NaN : Number(target.dataset.visorFocus);
    if (target !== null && Number.isFinite(gen) && gen > lastGen) {
      lastGen = gen;
      if (ours() && reachable(target)) {
        put(target);
        moved = true;
      }
    }

    if (dialog === null && dialogUp) {
      dialogUp = false;
      const back = beforeDialog;
      beforeDialog = null;
      // Cancel answered nothing and nothing moved, so the caret goes back
      // where it was. Save and Revert go on to a transition, and that
      // transition's own request wins: it is about where the user is now.
      if (!moved && ours() && reachable(back)) put(back);
    }
  }

  // stream-dom applies a chunk of mutations synchronously, so the callback
  // runs once per chunk with the commit already whole.
  new MutationObserver(settle).observe(visor, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["data-visor-focus", "data-visor-app-inert", "inert"],
  });
  settle();
}
