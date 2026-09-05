//! THE QR CODE — encoded in Rust, drawn as SVG through ordinary DOM
//! mutations, with no `document::eval` anywhere in it.
//!
//! # WHY THIS FILE NO LONGER EVALS, which is a reversal worth recording
//!
//! `visor/ui/pairing.ts:126-145` builds the code on a 2D canvas and returns a
//! `toDataURL` PNG, and that canvas was the stated reason the renderer's
//! `eval` capability was turned on at all: it looked like the one thing in
//! `visor/ui/` that a mutation surface could not express.
//!
//! MEASURED, IT IS NOT. A QR is a bitmap only incidentally — it is a grid of
//! axis-aligned rectangles, which is exactly what a vector format describes.
//! For the 79-character code the ceremony actually carries, the symbol is 37
//! modules a side (1,369 modules) and reduces to 362 horizontal RUNS, which
//! this file emits as a SINGLE SVG PATH: **two DOM nodes, one attribute**.
//!
//! So the capability had one customer and the customer did not need it. The
//! `eval` feature is off (`Cargo.toml`), and what that bought back is in the
//! wave report. The reasoning generalises and is worth keeping: on this seam,
//! "the host must compute it" and "the host must RASTERISE it" are different
//! claims, and only the first would have justified an escape hatch into
//! `document` from inside the trusted computing base.
//!
//! # WHY A PATH AND NOT ONE `<rect>` PER RUN
//!
//! Both are ordinary mutations and either would have been fine — 362 nodes
//! once per ceremony open is not a hot path. A path is chosen because it is
//! strictly cheaper on every axis that matters here (nodes the applier walks,
//! operations crossing the channel, memory held for the life of the sheet) and
//! costs only inspectability in devtools. Swapping back is a `for` loop over
//! [`Matrix::runs`]; the run decomposition is shared by both and is what the
//! tests actually pin.

use qrcode::{Color, EcLevel, QrCode};

/// Modules of white border on each side.
///
/// THE QUIET ZONE IS PART OF THE SYMBOL as far as a scanner is concerned, and
/// `qrcode`'s matrix is the modules only — so it is drawn here rather than
/// encoded. Four is the specification's minimum for a full QR symbol.
pub const QUIET: u32 = 4;

/// A QR symbol as bits, before anything has drawn it.
#[derive(Clone, PartialEq, Debug)]
pub struct Matrix {
    width: u32,
    /// Row-major, `width * width` entries. `true` is a dark module.
    dark: Vec<bool>,
}

impl Matrix {
    /// ENCODE, at the error-correction level `visor/ui/pairing.ts:131` uses
    /// (`QrCode.Ecc.MEDIUM`). Medium is the right trade for a code scanned off
    /// a screen in good light that expires in two minutes either way.
    ///
    /// `None` rather than a panic when the payload will not fit any version:
    /// this runs inside a live ceremony, and a visor that traps takes the whole
    /// instance — and the strip — down with it. The join sheet then renders the
    /// text code alone, which is a ceremony that still completes: the code is
    /// transcribable by hand and the QR is the convenience.
    pub fn encode(text: &str) -> Option<Self> {
        let code = QrCode::with_error_correction_level(text.as_bytes(), EcLevel::M).ok()?;
        // `to_colors`, not the deprecated `to_vec`: same row-major order, and
        // `Color` says which end of the enum is ink rather than leaving it to a
        // `bool` convention.
        let dark = code.to_colors().into_iter().map(|c| c == Color::Dark).collect();
        Some(Self { width: code.width() as u32, dark })
    }

    /// Modules per side, excluding the quiet zone.
    pub fn width(&self) -> u32 {
        self.width
    }

    /// The side of the drawn symbol in MODULE units, quiet zone included. The
    /// SVG's `viewBox` is `0 0 span span`, so the whole thing scales with the
    /// rendered box and there is no device-pixel scale factor anywhere.
    pub fn span(&self) -> u32 {
        self.width + QUIET * 2
    }

    /// THE DARK MODULES, RUN-LENGTH ENCODED per row: `(y, x, len)`.
    ///
    /// Shared by both renderings — the path below, and the one-`<rect>`-per-run
    /// alternative — and it is what made the eval question answerable: the run
    /// count IS the node count a naive DOM rendering would cost. Measured at
    /// 362 for a 79-character byte-mode code, against 1,369 modules.
    pub fn runs(&self) -> Vec<(u32, u32, u32)> {
        let mut runs = Vec::new();
        for y in 0..self.width {
            let row = &self.dark[(y * self.width) as usize..][..self.width as usize];
            let mut x = 0u32;
            while (x as usize) < row.len() {
                if !row[x as usize] {
                    x += 1;
                    continue;
                }
                let start = x;
                while (x as usize) < row.len() && row[x as usize] {
                    x += 1;
                }
                runs.push((y, start, x - start));
            }
        }
        runs
    }

    /// THE WHOLE SYMBOL AS ONE SVG PATH `d`, in module coordinates offset by
    /// the quiet zone.
    ///
    /// One `M x y h len v 1 h -len z` subpath per run. `z` closes each subpath
    /// so they are independent rectangles rather than one self-intersecting
    /// outline — which matters, because the default `nonzero` fill rule on a
    /// single unclosed figure would drop wherever subpaths overlapped.
    ///
    /// Integers only, so there is no float formatting and no locale in the
    /// output, and the string is byte-identical for a given code.
    pub fn svg_path(&self) -> String {
        let mut d = String::new();
        for (y, x, len) in self.runs() {
            d.push_str(&format!(
                "M{} {}h{}v1h-{}z",
                x + QUIET,
                y + QUIET,
                len,
                len
            ));
        }
        d
    }
}

#[cfg(test)]
mod tests {
    use super::{Matrix, QUIET};

    /// An obviously-synthetic payload of the length the ceremony actually
    /// carries: `visor/ui/pairing.ts:733` puts the join code at 79 characters.
    /// Nothing here is real key material — it is the lowercase alphabet
    /// repeated, which is what a fixture should look like.
    ///
    /// NOT ALL DIGITS, and that turned out to matter. `qrcode` picks an
    /// encoding mode per payload, and an all-numeric 79 characters packs into a
    /// version-3 symbol (29 modules) — less than a third the area a real code
    /// needs. Lowercase letters fall outside QR's alphanumeric set too, so this
    /// fixture takes the BYTE mode a real code takes and the figures below are
    /// representative rather than flattering.
    fn synthetic_code() -> String {
        "abcdefghij".repeat(8)[..79].to_string()
    }

    #[test]
    fn a_join_code_encodes_and_is_square() {
        let m = Matrix::encode(&synthetic_code()).expect("79 chars fits a QR symbol");
        assert!(m.width() >= 21, "no QR version is narrower than 21 modules");
        assert_eq!(m.width() % 4, 1, "every QR version is 4n+17 modules wide");
        assert_eq!(m.span(), m.width() + 8, "the quiet zone is four modules a side");
    }

    /// THE MEASUREMENT THE EVAL DECISION TURNED ON. A DOM rendering costs one
    /// node per run in its naive form, so the run count decides whether "draw
    /// it as DOM" is reasonable at all.
    ///
    /// Measured at 362 runs against 1,369 modules. Asserted as bounds rather
    /// than as the figure: the exact count moves with the encoder's mask
    /// choice, and the claim being defended is the order of magnitude.
    #[test]
    fn a_dom_rendering_costs_hundreds_of_nodes_not_thousands() {
        let m = Matrix::encode(&synthetic_code()).unwrap();
        let modules = (m.width() * m.width()) as usize;
        let runs = m.runs().len();
        assert!(runs * 3 < modules, "run-length merging is worth doing: {runs} vs {modules}");
        assert!(runs < 1_000, "a DOM rendering stays in the hundreds of nodes: {runs}");
    }

    /// The run decomposition must reproduce the matrix EXACTLY. A QR drawn
    /// wrong is a QR that silently fails to scan, which during a pairing
    /// ceremony looks like the backend being broken.
    #[test]
    fn runs_reconstruct_the_matrix() {
        let m = Matrix::encode(&synthetic_code()).unwrap();
        let mut rebuilt = vec![false; (m.width() * m.width()) as usize];
        for (y, x, len) in m.runs() {
            for i in 0..len {
                rebuilt[(y * m.width() + x + i) as usize] = true;
            }
        }
        assert_eq!(rebuilt, m.dark);
    }

    /// THE PATH IS THE RUNS, offset by the quiet zone and closed per run. Parsed
    /// back out of the `d` string and compared against the matrix, so a
    /// formatting slip cannot pass — the browser gate scans the rendered result,
    /// and this is the half that says WHY it scanned.
    #[test]
    fn the_svg_path_redraws_every_module_and_nothing_else() {
        let m = Matrix::encode(&synthetic_code()).unwrap();
        let d = m.svg_path();
        let mut rebuilt = vec![false; (m.width() * m.width()) as usize];
        let mut subpaths = 0;
        for sub in d.split('M').filter(|s| !s.is_empty()) {
            subpaths += 1;
            // "<x> <y>h<len>v1h-<len>z"
            let (xy, rest) = sub.split_once('h').expect("a run has a horizontal");
            let (x, y) = xy.split_once(' ').expect("a run starts at a point");
            let len: u32 = rest.split('v').next().unwrap().parse().unwrap();
            let x: u32 = x.parse().unwrap();
            let y: u32 = y.parse().unwrap();
            assert!(x >= QUIET && y >= QUIET, "the quiet zone is never drawn into");
            for i in 0..len {
                let idx = ((y - QUIET) * m.width() + (x - QUIET) + i) as usize;
                assert!(!rebuilt[idx], "a module is drawn exactly once");
                rebuilt[idx] = true;
            }
        }
        assert_eq!(subpaths, m.runs().len(), "one subpath per run");
        assert_eq!(rebuilt, m.dark, "the path is the matrix");
    }

    /// No floats, no locale, no separators a parser could trip on: the same
    /// code always produces the same bytes.
    #[test]
    fn the_path_is_integers_only_and_deterministic() {
        let m = Matrix::encode(&synthetic_code()).unwrap();
        let d = m.svg_path();
        assert_eq!(d, Matrix::encode(&synthetic_code()).unwrap().svg_path());
        assert!(!d.contains('.'), "no float formatting reaches the attribute");
        assert!(d.starts_with('M') && d.ends_with('z'));
    }

    /// A payload no QR version can hold answers `None` rather than trapping —
    /// the ceremony survives on the text code alone.
    #[test]
    fn an_unencodable_payload_refuses_instead_of_trapping() {
        assert!(Matrix::encode(&"a".repeat(10_000)).is_none());
    }
}
