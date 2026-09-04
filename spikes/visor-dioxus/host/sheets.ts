/// <reference lib="dom" />
// THE FOREIGN SHEET SEAM — the spike's central question on the host side.
//
// Governing docs: ../wit/world.wit (`embedder.tenant-build`/`tenant-unmount`,
// `control.mount-sheet`/`resize-sheet`),
// ../src/app.rs's header (the `.visor-slide` LEAF contract: the slide has
// NO children in the guest's own tree, so a foreign root is the only thing
// that may ever be appended into it), and ../src/drawer.rs's `suspend`
// (`tenant-unmount` fires on SUSPEND as well as on close — resume rebuilds
// rather than restores, so a suspended sheet is dead immediately and
// holding the reference past that leaks a detached tree).
//
// Three demo tenants, mirroring demo/host/demo.ts's shapes (registered by
// web/entry.ts): "credentials" (exclusive, armed, dim), "picker"
// (suspendable), "settings" (ordinary). Their sheets are built here as
// ordinary DOM using the class names visor/ui/visor.css actually styles —
// `.cred-sheet`/`.cred-field`/`.cred-row`, `.picker-sheet`/`.picker-entry`,
// `.settings-sheet` — with enough rows to overflow a phone-height budget,
// which is what the height-budget gate needs to exercise.
//
// SCOPE: this is NOT the real credentials/picker/settings ceremonies —
// dispatch forbids building those. It is the minimum DOM that makes the
// seam (append, measure, mount, resize, unmount) and the gates that depend
// on it (height budget, arm delay, foreign-slot survival) observable.

/** The subset of `control` this seam calls. */
export interface SheetControl {
  mountSheet(tenant: string, height: number): void;
  resizeSheet(height: number): void;
}

// Enough rows that the natural height clears any budget a phone-height
// viewport (drawer-overflow.ts's own VIEWPORT: 390x664) can offer, so the
// height-budget gate's internal-scroll claim is not trivially true.
const CRED_FIELDS = 20;
const PICKER_ENTRIES = 10;

function credentialsSheet(): HTMLElement {
  const root = document.createElement("div");
  // NOT `.armed` yet: visor.css:754-757's comment is the enforcement rule
  // this seam has to honour — "the disabled attribute is the enforcement,
  // [the class] is only its visible form" — so the sheet is built ARMED
  // OFF and `ForeignSlotHost.arm` is the one place that flips it, in
  // response to the real `embedder.tenant-armed` notification (i.e. the
  // clock in src/drawer.rs's ARM_MS, not a guess made here).
  root.className = "cred-sheet";
  const h2 = document.createElement("h2");
  h2.textContent = "credentials";
  root.appendChild(h2);
  for (let i = 0; i < CRED_FIELDS; i++) {
    const field = document.createElement("div");
    field.className = "cred-field";
    const label = document.createElement("label");
    label.textContent = `field ${i}`;
    const input = document.createElement("input");
    input.type = "text";
    field.append(label, input);
    root.appendChild(field);
  }
  const row = document.createElement("div");
  row.className = "cred-row";
  const go = document.createElement("button");
  go.type = "button";
  go.textContent = "continue";
  go.disabled = true;
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.textContent = "cancel";
  cancel.disabled = true;
  row.append(go, cancel);
  root.appendChild(row);
  return root;
}

function pickerSheet(): HTMLElement {
  const root = document.createElement("div");
  root.className = "picker-sheet";
  const lists = document.createElement("div");
  lists.className = "picker-lists";
  for (let i = 0; i < PICKER_ENTRIES; i++) {
    const entry = document.createElement("div");
    entry.className = "picker-entry";
    const id = document.createElement("div");
    id.className = "picker-entry-id";
    id.textContent = `device ${i}`;
    const what = document.createElement("div");
    what.className = "picker-entry-what";
    what.textContent = `storage kind ${i}`;
    entry.append(id, what);
    lists.appendChild(entry);
  }
  root.appendChild(lists);
  const row = document.createElement("div");
  row.className = "picker-row";
  const connect = document.createElement("button");
  connect.type = "button";
  connect.textContent = "connect";
  row.appendChild(connect);
  root.appendChild(row);
  return root;
}

function settingsSheet(): HTMLElement {
  const root = document.createElement("div");
  // `.settings-sheet` wears `.cred-sheet`'s shape (visor.css:9) and adds
  // its own vocabulary on top.
  root.className = "settings-sheet cred-sheet";
  const head = document.createElement("div");
  head.className = "settings-head";
  const h2 = document.createElement("h2");
  h2.textContent = "your visor";
  head.appendChild(h2);
  const reset = document.createElement("div");
  reset.className = "settings-reset";
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "reset";
  btn.textContent = "erase this visor";
  reset.appendChild(btn);
  root.append(head, reset);
  return root;
}

const BUILDERS: Record<string, () => HTMLElement> = {
  credentials: credentialsSheet,
  picker: pickerSheet,
  settings: settingsSheet,
};

/** The live, non-departing, STILL-EMPTY slide: the renderer's own invariant
 * (src/drawer.rs's `present`) is that the incoming slide is the LAST
 * `.visor-slide` that is not `.visor-swap-out` — an outgoing slide during a
 * swap is still mounted for the length of its own travel and must never be
 * mistaken for the one a fresh build belongs in.
 *
 * EMPTY IS PART OF THE TEST, not an optimisation: `.visor-slide` is a LEAF
 * (src/app.rs's header — the guest never gives it children), so the OLD
 * occupant's slide still holds its own foreign root at the instant this
 * runs (a race `#awaitSlide` below exists to resolve — see its own
 * comment). Filtering to empty slides is what keeps a build from
 * attaching to that stale slide during the one-or-more animation frames
 * before the renderer has actually re-labelled it `.visor-swap-out` and
 * mounted the real incoming sibling. */
function liveSlide(): HTMLElement | null {
  const slides = Array.from(
    document.querySelectorAll<HTMLElement>("#visor-drawer-inner .visor-slide:not(.visor-swap-out)"),
  ).filter((s) => s.children.length === 0);
  return slides.length > 0 ? slides[slides.length - 1] : null;
}

/** Holds every foreign sheet root the host has appended into a live slide,
 * keyed by tenant name, and the ResizeObserver watching it. Exactly the
 * seam wit/world.wit describes: the guest never rendered this DOM and has
 * no ElementId for it, so `dom.get-client-rect` cannot see it — the host
 * built it and the host measures it. */
export class ForeignSlotHost {
  #roots = new Map<string, HTMLElement>();
  #observers = new Map<string, ResizeObserver>();
  /** The most recently mounted, not-yet-unmounted tenant: the one whose
   * sheet occupies the live slide. At most
   * one sheet is ever "the live slide's occupant" in this spike's tenant
   * set (no two of credentials/picker/settings open at once — `open`
   * evicts or suspends), so tracking a single active name is exact rather
   * than a simplification. */
  #active: string | undefined;

  constructor(private readonly control: SheetControl) {
    // Viewport resizes affect the BUDGET, not the sheet's own natural
    // height — but `control.resize-sheet` is the one call that re-clamps
    // against a freshly read `chrome.viewport-height()` (drawer.rs's
    // `resize_sheet` reads the budget internally), so re-reporting the
    // active sheet's unchanged natural height on a viewport resize is
    // what keeps the drawer's height correct when the window shrinks or
    // grows under it.
    globalThis.addEventListener("resize", () => {
      if (this.#active === undefined) return;
      const el = this.#roots.get(this.#active);
      if (el) this.control.resizeSheet(el.offsetHeight);
    });
  }

  /** `embedder.tenant-build`: build the tenant's sheet, append it into the
   * live slide (the ONLY thing that may ever go into that leaf — see
   * src/app.rs's header), measure it, and complete the round trip.
   *
   * NOT SYNCHRONOUS WITH THE CALL THAT TRIGGERED IT. `tenant-build` fires
   * inside the SAME guest call that just pushed the new `Slide` onto the
   * render signal (`open`/`resume`/`rebuild` in src/drawer.rs, drained by
   * `apply_effects` in src/component.rs) — but that call is a plain (not
   * `async`) WIT export, so it returns to the host before the renderer's
   * OWN async task (parked on `ops.read()`) ever gets a turn to notice the
   * dirty signal and emit the mutation that actually creates the
   * `.visor-slide` element. The DOM this function needs is therefore not
   * there yet the instant this runs; it has to wait for the next flush.
   * `requestAnimationFrame` polling is what does that without a
   * host-side "flush complete" signal, which nothing on the WIT surface
   * provides. */
  build(tenant: string): void {
    const make = BUILDERS[tenant];
    if (!make) return; // out of scope for this spike's three demo tenants
    this.#awaitSlide(tenant, make, 0);
  }

  #awaitSlide(tenant: string, make: () => HTMLElement, tries: number): void {
    const slide = liveSlide();
    if (!slide) {
      if (tries > 300) return; // ~5s at 60Hz; something is structurally wrong
      requestAnimationFrame(() => this.#awaitSlide(tenant, make, tries + 1));
      return;
    }
    const el = make();
    slide.appendChild(el);
    const height = el.offsetHeight;
    const ro = new ResizeObserver(() => {
      this.control.resizeSheet(el.offsetHeight);
    });
    ro.observe(el);
    this.#roots.set(tenant, el);
    this.#observers.set(tenant, ro);
    this.#active = tenant;
    this.control.mountSheet(tenant, height);
  }

  /** `embedder.tenant-unmount`: fires on close AND on suspend
   * (src/drawer.rs's `suspend`) — a suspended tenant's sheet is dead
   * immediately (resume rebuilds, never restores), so the reference is
   * dropped here unconditionally. The DOM node itself departs with its
   * slide when the renderer removes it; this only releases the JS-side
   * hold (the ResizeObserver, the map entry) so nothing here keeps a
   * detached tree alive. */
  unmount(tenant: string): void {
    this.#observers.get(tenant)?.disconnect();
    this.#observers.delete(tenant);
    this.#roots.delete(tenant);
    if (this.#active === tenant) this.#active = undefined;
  }

  /** `embedder.tenant-armed`: the delay elapsed, so the sheet's controls
   * may go live. Flips the visible `.armed` class AND lifts `disabled` —
   * the disabled attribute is the actual enforcement (visor.css:754-757),
   * the class is only its visible form; this is the one call site that
   * ever removes it, and it runs only in response to the real
   * notification. */
  arm(tenant: string): void {
    const el = this.#roots.get(tenant);
    if (!el) return;
    el.classList.add("armed");
    for (const btn of el.querySelectorAll<HTMLButtonElement>(".cred-row button")) {
      btn.disabled = false;
    }
  }

  /** For the e2e's foreign-slot assertions: how many foreign roots this
   * host currently holds a reference to (never more than 1 in this
   * spike's tenant set) and whether a given root is still attached to the
   * document (a swap must never leave two live foreign roots in one
   * slide, and a suspend must not leak a detached one). */
  liveCount(): number {
    return this.#roots.size;
  }
}
