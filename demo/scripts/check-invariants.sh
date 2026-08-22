#!/usr/bin/env bash
# Source-level invariant checks for the demo visor (#22 ruling table).
#
# These are the invariants that are cheap to STATE and expensive to
# notice the loss of: each one is a property of the source text, so a
# refactor that quietly breaks it fails here instead of failing in a
# browser six weeks later. They are not a substitute for the reasoning in
# host/demo.ts's comments — they are the tripwires on it.
#
# Run from anywhere; paths resolve relative to demo.
set -uo pipefail

cd "$(dirname "$0")/.." || exit 2

fail=0

ok() { printf '  ok   %s\n' "$1"; }
bad() {
  printf '  FAIL %s\n' "$1"
  fail=1
}

# --- (a) the petname never crosses the frame seam ---------------------------
# The user's own word for a component is visor-side state. A component
# that could read it could impersonate the user's trust in itself; a
# component that could influence it could put attacker-chosen words into
# the visor's own voice. So it must not appear anywhere on the seam.
echo "[1/8] petname never crosses the frame seam"
echo "      (the visor's word for a component is never readable or influenceable by it)"
hits=$(grep -n "petname" ../visor/frame/frame-backend.ts ../visor/frame/frame.ts ../visor/frame/frame.html 2>/dev/null)
if [ -n "$hits" ]; then
  bad "petname appears on the frame seam:"
  printf '%s\n' "$hits" | sed 's/^/       /'
else
  ok "no petname reference in ../visor/frame/frame-backend.ts, ../visor/frame/frame.ts, ../visor/frame/frame.html"
fi

# --- (b) the visor never writes the word "password" ---------------------------
# A panel may DECLARE a credential kind; the visor renders the field with
# the visor's own words. "password" is never one of them: the moment the
# visor's pixels ask for a password on a panel's behalf, the panel has
# borrowed the visor's authority. The ONLY admissible occurrence is the
# bare token "password" as an input-masking type — never inside a sentence.
# Comments are exempt: they explain the rule rather than render it.
echo "[2/8] the visor never renders the word \"password\""
echo "      (the visor's labels are the visor's own; a panel must never borrow them)"
# BOTH halves of the visor render strings now: the system-UI core
# (visor/ui/*.ts — visor.ts's strip/drawer host, sheets.ts's naming and
# settings ceremonies) and the demo's own sheet content (host/demo.ts).
# The scan covers all of it — as a GLOB, so it follows the next file the
# framework layer grows rather than needing this list edited, which is
# exactly the miss this check would otherwise have after the naming and
# settings sheets moved out of host/demo.ts.
VISOR_RENDERERS="host/demo.ts host/solo.ts ../visor/ui/*.ts"
# shellcheck disable=SC2086
prose=$(cat $VISOR_RENDERERS | sed -E 's@^[[:space:]]*(//|\*|/\*).*@@' |
  grep -oiE '"[^"]*password[^"]*"' | grep -vx '"password"')
if [ -n "$prose" ]; then
  bad "a visor-rendered string literal contains \"password\":"
  printf '%s\n' "$prose" | sed 's/^/       /'
else
  ok "no string literal in $VISOR_RENDERERS spells password inside prose"
fi
# And the bare token is only ever the masking type, never a label.
# shellcheck disable=SC2086
misuse=$(grep -n '"password"' $VISOR_RENDERERS |
  grep -vE '^[^:]+:[0-9]+:[[:space:]]*(//|\*)' |
  grep -vE 'type: "password"|"text" \| "password"')
if [ -n "$misuse" ]; then
  bad "\"password\" used somewhere other than the input-masking type:"
  printf '%s\n' "$misuse" | sed 's/^/       /'
else
  ok "the bare \"password\" token appears only as an input type"
fi

# --- (c) the anchor colour is never ambient --------------------------------
# --visor-bg carries the user's personal, undisclosed anchor colour. Set
# on the document root it INHERITS into every app region, so a component
# that ever gained a style attribute (or a class resolving the variable)
# could paint the visor's exact colour without reading it. Scope keeps the
# secrecy structural instead of a property of the allowlist.
echo "[3/8] the anchor colour is never made ambient"
echo "      (--visor-bg is scoped to the visor's own elements; inheriting it would disclose it)"
# `applyVisorHue` lives in the framework core now, so the scan follows
# it there; host/*.ts stays in the list because a consumer painting the
# anchor colour itself would be exactly the regression this catches.
HUE_PAINTERS="host/*.ts ../runtime/*.ts ../runtime/device-store/*.ts ../visor/ui/*.ts"
# shellcheck disable=SC2086
ambient=$(grep -nE '(documentElement|:root)[^\n]*--visor-bg' $HUE_PAINTERS 2>/dev/null)
if [ -n "$ambient" ]; then
  bad "--visor-bg applied to the document root in $HUE_PAINTERS:"
  printf '%s\n' "$ambient" | sed 's/^/       /'
else
  ok "no line in $HUE_PAINTERS sets --visor-bg on documentElement/:root"
fi
for css in web/index.html ../visor/ui/visor.css; do
  rootdecl=$(awk '
    /:root/ { inroot = 1 }
    inroot && /--visor-bg[[:space:]]*:/ { printf "%d: %s\n", NR, $0 }
    /}/ { inroot = 0 }
  ' "$css")
  if [ -n "$rootdecl" ]; then
    bad "--visor-bg declared inside a :root block in $css:"
    printf '%s\n' "$rootdecl" | sed 's/^/       /'
  else
    ok "$css declares --visor-bg in no :root block"
  fi
done

# --- (d) no key is ever exported from the visor ------------------------------
# An escrowed signing credential is stored as a NON-EXTRACTABLE WebCrypto
# handle (../runtime/keystore.ts): `crypto.subtle.exportKey` on it throws by
# construction, so the guarantee is the platform's rather than ours. What
# this check defends is the *construction* — a later "just for debugging"
# export path, or an import that quietly passes extractable: true and a
# matching read-back, would turn the handle back into a bearer string.
# Banning the verb outright from host and runtime code keeps the property
# one grep wide instead of a review argument. Comments are exempt: they
# explain the rule rather than perform it.
echo "[4/8] the visor never exports a key"
echo "      (escrowed signing keys are non-extractable; nothing reads them back)"
exported=$(grep -n "exportKey" host/*.ts ../runtime/*.ts ../runtime/device-store/*.ts 2>/dev/null |
  grep -vE "^[^:]+:[0-9]+:[[:space:]]*(//|\*|/\*)")
if [ -n "$exported" ]; then
  bad "exportKey appears in host or runtime code:"
  printf '%s\n' "$exported" | sed 's/^/       /'
else
  ok "no host/*.ts or ../runtime/*.ts line calls exportKey"
fi

# --- (e) the user's identity never crosses the frame seam -------------------
# The user's own name, their word for this device and the glyph on
# the visor's button are rendered ONLY in visor pixels. They are a second
# thing an impersonating rectangle cannot reproduce — but only for as
# long as a component cannot read them. A component that could would be
# able to greet the user by name from inside its own rectangle, which is
# precisely the impersonation the strip exists to make impossible; one
# that could INFLUENCE them would be putting attacker-chosen words into
# the visor's own voice on the anchor. So neither the storage key nor the
# cluster's id may appear anywhere on the seam.
echo "[5/8] the user's identity never crosses the frame seam"
echo "      (name, device and icon are visor pixels; no component may read or steer them)"
idhits=$(grep -n "pm-demo-identity\|visor-identity" \
  ../visor/frame/frame.ts ../visor/frame/frame-backend.ts ../visor/frame/frame.html 2>/dev/null)
if [ -n "$idhits" ]; then
  bad "the visor identity record appears on the frame seam:"
  printf '%s\n' "$idhits" | sed 's/^/       /'
else
  ok "no identity reference in ../visor/frame/frame.ts, ../visor/frame/frame-backend.ts, ../visor/frame/frame.html"
fi

# --- (f) pairing code and SAS render only in visor-owned surfaces --------
# PAIRING.md §5's CI invariant: "the pairing code and SAS render
# only in visor-owned surfaces, never inside a component frame". The
# grep-enforceable marker (chosen by Track B, per that section): both
# are rendered EXCLUSIVELY through two named functions,
# `renderPairingCode(` and `renderSas(`, defined once in
# ../visor/ui/pairing.ts (see that file's own comment at the
# definitions for the reasoning — pinning the RENDERING CALL SITE is a
# stronger property than grepping the word "SAS", which would also fire
# on comments). A component frame has no path to a host-side function
# call at all, so if either name ever appeared outside that module the
# architecture itself would have grown a new seam-crossing path.
#
# The check got STRONGER when the pairing UI moved out of the demo and
# into visor/ui/ (2026-08-20): the exclusivity is now a property of the
# framework layer rather than of one demo file, so the definer scan
# covers BOTH the visor's own UI modules and every demo host file —
# a rogue definition anywhere on either side fails here.
echo "[6/8] pairing code and SAS render only in visor-owned surfaces"
echo "      (renderPairingCode()/renderSas() are defined and called only in ../visor/ui/pairing.ts)"
outside=$(grep -rln "renderPairingCode(\|renderSas(" \
  ../visor/frame/frame.ts ../visor/frame/frame-backend.ts ../visor/frame/frame.html web/frame.js \
  ../examples/todomvc/guest ../providers/s3/panel ../providers/dropbox/panel \
  2>/dev/null)
if [ -n "$outside" ]; then
  bad "renderPairingCode()/renderSas() referenced outside ../visor/ui/pairing.ts:"
  printf '%s\n' "$outside" | sed 's/^/       /'
else
  ok "no reference to renderPairingCode()/renderSas() outside ../visor/ui/pairing.ts"
fi
# shellcheck disable=SC2086
definers=$(grep -rl "^function renderPairingCode(\|^function renderSas(" \
  host/*.ts ../runtime/*.ts ../runtime/device-store/*.ts ../visor/ui/*.ts 2>/dev/null | grep -v '/visor/ui/pairing.ts$')
if [ -n "$definers" ]; then
  bad "renderPairingCode()/renderSas() defined somewhere other than ../visor/ui/pairing.ts:"
  printf '%s\n' "$definers" | sed 's/^/       /'
else
  ok "renderPairingCode()/renderSas() are defined only in ../visor/ui/pairing.ts"
fi

# --- (g) the pet-icon vocabulary is curated, and validated at the seam -------
# Two halves of one property (#22 discussion): the visor's per-app
# recognition mark is a GLYPH the user picks, and the set it is picked
# from is the visor's whole defence.
#
#   (g1) THE SET CARRIES NO SECURITY SEMANTICS. A padlock, a shield, a
#        tick or a warning sign beside a component's name is the visor
#        appearing to VOUCH for that component — a claim made in the
#        anchor's pixels, on the user's own authority, that the visor is
#        in no position to make.
#
#        THE RULE IS ONE-WAY, and only this direction is checked. The
#        USER'S own set (visor.ts's VISOR_ICONS) is now a SUPERSET of
#        APP_MARK_ICONS by decision, so the two overlap on purpose and a
#        disjointness check would be false. It may also hold
#        security-semantic glyphs — ⛨ is its default — because a user
#        awarding themselves a shield speaks on their own authority in
#        their own cluster, while an app wearing one is a claim about the
#        app made in the visor's pixels. "Me" versus "it" is carried by
#        POSITION (identity cluster vs context cluster, neither of them
#        drawable by a component) and by the circular "me" shape, not by
#        set membership. What survives here is the app half: the denylist
#        still covers the ten glyphs the visor's own BUTTON shipped with
#        (VISOR_ICON_CORE), because a component mark confusable with the
#        button's own face is an impersonation aid.
#
#   (g2) A NOMINATED GLYPH IS VALIDATED AT THE CROSSING. A component may
#        ASK to wear a mark (`mark-nomination`), which makes it the one
#        component-influenced string in the mark story — and the
#        interesting inputs are bidi overrides, ZWJ sequences composing
#        into colour emoji, and homoglyphs of the visor's own icons.
#        `isAppMarkIcon` refuses all of them by membership, but only if
#        it is called where the value ENTERS. So the check pins the
#        ADJACENCY: the call must appear in the same file, within a few
#        lines of the read.
echo "[7/8] the pet-icon vocabulary is curated, and a nomination is validated at the seam"
echo "      (no security-semantic glyph in APP_MARK_ICONS; isAppMarkIcon guards the mark-nomination read)"
ICONS_FILE=../visor/ui/visor.ts
# The literal set, from the opening bracket to the closing one. Read as
# TEXT: the point is that nothing in the source can smuggle a glyph past
# this, including a computed one — which would itself be a finding.
set_literal=$(awk '/^export const APP_MARK_ICONS/ { inset = 1 } inset { print } inset && /^\];/ { exit }' "$ICONS_FILE")
if [ -z "$set_literal" ]; then
  bad "APP_MARK_ICONS not found as an array literal in $ICONS_FILE"
else
  # Locks, shields, keys, warning signs, ticks and crosses — plus every
  # glyph of the visor button's own core (visor.ts's VISOR_ICON_CORE).
  denied=""
  for glyph in '⛨' '🛡' '⚠' '✓' '✔' '✗' '✘' '✖' '❌' '🔒' '🔐' '🔓' '🔑' '⚿' '⛊' '⛉' '☑' '☒' '⌘' \
               '✶' '✦' '◆' '▲' '☘' '⚑' '✿' '☾' '⚙'; do
    case "$set_literal" in
      *"$glyph"*) denied="$denied $glyph" ;;
    esac
  done
  if [ -n "$denied" ]; then
    bad "APP_MARK_ICONS contains a denied glyph (security semantics, or the visor button's own core):$denied"
  else
    ok "APP_MARK_ICONS spells no lock/shield/key/warning/tick/cross, and no VISOR_ICON_CORE glyph"
  fi
fi
# The seam: every read of a component's nomination goes through ONE
# validating funnel, `readMarkNomination`, and that funnel calls
# `isAppMarkIcon`. Two cheap greps for one property — pinning the funnel
# is stronger than pinning a line-distance, because a new call site that
# forgot to validate would have to reintroduce the raw read to escape it.
# CODE ONLY. Comments explaining the rule are not the rule — this check
# exists precisely to catch a funnel whose prose still promises what its
# body stopped doing.
# (A single-file `grep -n` prints `LINE:` with no filename, hence the
# leading-number form of the comment filter here.)
funnel=$(grep -n "isAppMarkIcon" host/demo.ts |
  grep -vE '^[0-9]+:[[:space:]]*(//|\*|/\*)' | grep -c .)
if [ "$funnel" -lt 1 ]; then
  bad "host/demo.ts never calls isAppMarkIcon — nothing validates a nominated glyph"
else
  ok "host/demo.ts calls isAppMarkIcon (the nomination funnel validates)"
fi
# Any `markNomination()` read that is NOT inside the funnel: strip the
# interface DECLARATIONS (which end in `;`), then require a
# `readMarkNomination(` within the six lines above each survivor.
raw=$(grep -n "markNomination()" host/*.ts ../runtime/*.ts ../runtime/device-store/*.ts |
  grep -vE '^[^:]+:[0-9]+:[[:space:]]*(//|\*)' |
  grep -vE 'markNomination\(\): Promise')
unguarded=""
while IFS= read -r line; do
  [ -z "$line" ] && continue
  f=${line%%:*}; rest=${line#*:}; n=${rest%%:*}
  from=$(( n > 6 ? n - 6 : 1 ))
  # Comment lines are stripped from the window for the same reason: a
  # comment that MENTIONS readMarkNomination is not a call to it.
  if ! sed -n "${from},${n}p" "$f" | sed -E 's@^[[:space:]]*(//|\*|/\*).*@@' |
       grep -q "readMarkNomination"; then
    unguarded="$unguarded
       $line"
  fi
done <<EOF
$raw
EOF
if [ -n "$unguarded" ]; then
  bad "a mark-nomination read bypasses readMarkNomination (and therefore isAppMarkIcon):$unguarded"
else
  ok "every mark-nomination read goes through readMarkNomination"
fi

# --- (h) app voice is CONSTRUCTED, never styled by hand ---------------------
# The three-voices rule (visor/ui/visor.css's header, visor/README.md):
# every string the visor renders is framework voice, user voice or APP
# voice, and app voice — a component-influenced string — is quoted,
# monospaced, textually attributed and plated. All of that hangs off one
# class, `foreign`.
#
# THE RULE IS ONE-DIRECTIONAL, and that is why it is checkable: an
# app-influenced string must only be renderable through the app-voice
# constructor; the reverse direction (visor text accidentally styled as a
# plate) is ugly but not dangerous. So the property to enforce is not
# "everything plated is foreign" — it is "there is exactly ONE DOOR", and
# a hand-written class assignment anywhere else is a second door that a
# later refactor can forget to dress (or, worse, dress inconsistently, so
# that one app string on one sheet reads as the visor's own words).
#
# Part 1: no `foreign` class assignment anywhere else in visor-rendering
# code. Part 2: exactly one inside visor.ts — the constructor itself.
# CODE ONLY, both halves: the comments here and there DESCRIBE the class,
# and a check that counted prose would be a check on the prose.
echo "[8/8] app-voice text is built by the constructor, never class-assigned by hand"
echo "      (foreignToken() in ../visor/ui/visor.ts is the only door to the \"foreign\" class)"
# A class ASSIGNMENT mentioning foreign, in any of the shapes the DOM
# offers: className =, classList.add(...), setAttribute("class", ...).
FOREIGN_ASSIGN='(className[[:space:]]*=|classList\.(add|toggle)\(|setAttribute\([[:space:]]*"class")[^\n]*foreign'
VOICE_RENDERERS=$(ls host/*.ts ../runtime/*.ts ../runtime/device-store/*.ts ../visor/ui/*.ts 2>/dev/null | grep -v '/visor/ui/visor\.ts$')
handmade=""
for f in $VOICE_RENDERERS; do
  hit=$(sed -E 's@^[[:space:]]*(//|\*|/\*).*@@' "$f" | grep -nE "$FOREIGN_ASSIGN")
  [ -n "$hit" ] && handmade="$handmade
       $f:$(printf '%s' "$hit" | tr '\n' ' ')"
done
if [ -n "$handmade" ]; then
  bad "the \"foreign\" class is assigned outside the constructor:$handmade"
else
  ok "no host/*.ts, ../runtime/*.ts or ../visor/ui/*.ts file outside visor.ts assigns the \"foreign\" class"
fi
# And inside visor.ts: EXACTLY ONE. Zero would mean the door was renamed
# or removed (and the check silently stopped meaning anything); two would
# mean a second door exists in the very file that is supposed to hold the
# only one.
doors=$(sed -E 's@^[[:space:]]*(//|\*|/\*).*@@' ../visor/ui/visor.ts |
  grep -cE "$FOREIGN_ASSIGN")
if [ "$doors" -ne 1 ]; then
  bad "../visor/ui/visor.ts has $doors \"foreign\" class assignments, expected exactly 1 (foreignToken is the only door: app-influenced strings must only be renderable through the app-voice constructor)"
else
  ok "../visor/ui/visor.ts assigns the \"foreign\" class in exactly 1 place (foreignToken)"
fi

echo
if [ "$fail" -ne 0 ]; then
  echo "invariant check FAILED — see above (#22 ruling table)"
  exit 1
fi
echo "invariant check passed"
