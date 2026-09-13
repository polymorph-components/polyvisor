//! A single app-owned Automerge text document rendered through stream-dom.

use std::{cell::RefCell, rc::Rc};

use automerge::{
    ActorId, Automerge, Cursor, CursorPosition, MoveCursor, ObjId, ObjType, ROOT, ReadDoc,
    transaction::Transactable,
};
use dioxus::prelude::*;
use futures::StreamExt;
use pulldown_cmark::{Event, HeadingLevel, Options, Parser, Tag};
use stream_dom_dioxus::{
    TextControlDataExt, TextControlSelectionDirection, TextControlState, text_control_state,
};

#[cfg(target_arch = "wasm32")]
#[allow(clippy::empty_docs)]
mod bindings {
    wit_bindgen::generate!({
        path: "../../wit",
        world: "markdown-app",
        with: {
            "polymorph:stream-dom/types@0.1.0": stream_dom_guest::bindings::polymorph::stream_dom::types,
            "polymorph:stream-dom/queries@0.1.0": stream_dom_guest::bindings::polymorph::stream_dom::queries,
            "polymorph:stream-dom/events@0.1.0": stream_dom_guest::bindings::polymorph::stream_dom::events,
        },
    });
}

#[cfg(target_arch = "wasm32")]
struct Component;

#[cfg(target_arch = "wasm32")]
impl bindings::Guest for Component {
    async fn run(hydrate: bool) -> stream_dom_dioxus::driver::MutationStream {
        stream_dom_dioxus::driver::run(app, hydrate).await
    }

    async fn handle_event(
        target: bindings::EventTarget,
        name: u32,
        payload: Vec<u8>,
        event: &bindings::DomEvent,
    ) {
        stream_dom_dioxus::driver::handle_event(target, name, payload, event).await
    }
}

#[cfg(target_arch = "wasm32")]
bindings::export!(Component with_types_in bindings);

const APP_CSS: &str = "asset:0430efa1fd64dcfd582ad29ff44da4102afef1fdb99dd26110f0deb36ff2cfea";
const BODY: &str = "body";
const GENESIS_ACTOR: &[u8] = b"polyvisor-markdown-genesis-v1";

#[derive(Clone)]
struct StableSelection {
    start: Cursor,
    end: Cursor,
    direction: TextControlSelectionDirection,
    is_composing: bool,
}

struct MarkdownDocument {
    doc: Automerge,
    body: ObjId,
    genesis: Vec<Vec<u8>>,
    selection: StableSelection,
}

impl MarkdownDocument {
    fn new(actor: ActorId) -> Self {
        // CONTRACT: every empty replica authors this byte-identical change so
        // BODY resolves to one Text object even when replicas start offline.
        let mut doc = Automerge::new().with_actor(ActorId::from(GENESIS_ACTOR));
        let before = doc.get_heads();
        let body = doc
            .transact(|tx| tx.put_object(ROOT, BODY, ObjType::Text))
            .expect("fixed genesis transaction")
            .result;
        let genesis = doc
            .get_changes(&before)
            .into_iter()
            .map(|change| change.raw_bytes().to_vec())
            .collect();
        let _ = doc.set_actor(actor);
        Self {
            doc,
            body,
            genesis,
            selection: StableSelection {
                start: Cursor::Start,
                end: Cursor::Start,
                direction: TextControlSelectionDirection::None,
                is_composing: false,
            },
        }
    }

    fn merge_snapshot(&mut self, bytes: &[u8]) -> Result<bool, String> {
        if bytes.is_empty() {
            return Ok(false);
        }
        let mut remote = Automerge::load(bytes).map_err(err)?;
        let remote_has_genesis = matches!(
            remote.get(ROOT, BODY).map_err(err)?,
            Some((automerge::Value::Object(ObjType::Text), _))
        );
        self.doc.merge(&mut remote).map_err(err)?;
        self.body = self
            .doc
            .get(ROOT, BODY)
            .map_err(err)?
            .and_then(|(value, id)| {
                matches!(value, automerge::Value::Object(ObjType::Text)).then_some(id)
            })
            .ok_or_else(|| "Markdown body is missing after history merge".to_string())?;
        Ok(remote_has_genesis)
    }

    fn control_state(&self) -> Result<TextControlState, String> {
        let value = self.doc.text(&self.body).map_err(err)?;
        let start = self
            .doc
            .get_cursor_position(&self.body, &self.selection.start, None)
            .map_err(err)?;
        let end = self
            .doc
            .get_cursor_position(&self.body, &self.selection.end, None)
            .map_err(err)?;
        Ok(TextControlState {
            selection_start: scalar_to_utf16(&value, start)?,
            selection_end: scalar_to_utf16(&value, end)?,
            value,
            direction: self.selection.direction,
            is_composing: self.selection.is_composing,
        })
    }

    fn input(&mut self, state: &TextControlState) -> Result<Vec<Vec<u8>>, String> {
        let old = self.doc.text(&self.body).map_err(err)?;
        let heads = self.doc.get_heads();
        let (start, deleted, inserted) = scalar_diff(&old, &state.value);
        self.doc
            .transact(|tx| {
                tx.splice_text(&self.body, start, deleted as isize, inserted)
                    .map_err(err)
            })
            .map_err(|failure| failure.error)?;
        self.capture_selection(state)?;
        Ok(self
            .doc
            .get_changes(&heads)
            .into_iter()
            .map(|change| change.raw_bytes().to_vec())
            .collect())
    }

    fn capture_selection(&mut self, state: &TextControlState) -> Result<(), String> {
        let value = self.doc.text(&self.body).map_err(err)?;
        if value != state.value {
            return Err("selection snapshot does not match the current Markdown text".into());
        }
        let start = utf16_to_scalar(&value, state.selection_start)?;
        let end = utf16_to_scalar(&value, state.selection_end)?;
        let start_cursor = boundary_cursor(&self.doc, &self.body, start, MoveCursor::After)?;
        let end_cursor = if start == end {
            start_cursor.clone()
        } else {
            // A text position names the item after the boundary. `After` on
            // both endpoints therefore keeps an ordinary range's boundaries
            // exact and collapses both to the next survivor when all selected
            // anchors are deleted. `Before` resolves to the previous item's
            // index, not the boundary after it, and can cross the start.
            boundary_cursor(&self.doc, &self.body, end, MoveCursor::After)?
        };
        self.selection = StableSelection {
            start: start_cursor,
            end: end_cursor,
            direction: state.direction,
            is_composing: state.is_composing,
        };
        Ok(())
    }

    #[cfg(test)]
    fn edit_text(&mut self, value: &str) -> Result<Vec<Vec<u8>>, String> {
        self.input(&TextControlState {
            value: value.to_owned(),
            selection_start: scalar_to_utf16(value, value.chars().count())?,
            selection_end: scalar_to_utf16(value, value.chars().count())?,
            direction: TextControlSelectionDirection::None,
            is_composing: false,
        })
    }

    #[cfg(test)]
    fn from_snapshot(bytes: &[u8], actor: u8) -> Result<Self, String> {
        let mut document = Self::new(ActorId::from(&[actor][..]));
        document.merge_snapshot(bytes)?;
        Ok(document)
    }
}

fn err(error: impl std::fmt::Display) -> String {
    error.to_string()
}

/// Automerge Text positions count Unicode scalar values, not UTF-8 bytes.
fn scalar_diff<'a>(old: &str, new: &'a str) -> (usize, usize, &'a str) {
    let prefix = old
        .chars()
        .zip(new.chars())
        .take_while(|(a, b)| a == b)
        .count();
    let old_tail = old.chars().skip(prefix).collect::<Vec<_>>();
    let new_tail = new.chars().skip(prefix).collect::<Vec<_>>();
    let suffix = old_tail
        .iter()
        .rev()
        .zip(new_tail.iter().rev())
        .take_while(|(a, b)| a == b)
        .count();
    let start_byte = new.char_indices().nth(prefix).map_or(new.len(), |(i, _)| i);
    let end_scalar = new.chars().count() - suffix;
    let end_byte = new
        .char_indices()
        .nth(end_scalar)
        .map_or(new.len(), |(i, _)| i);
    (prefix, old_tail.len() - suffix, &new[start_byte..end_byte])
}

fn utf16_to_scalar(value: &str, offset: u32) -> Result<usize, String> {
    let mut utf16 = 0_u32;
    for (scalar, ch) in value.chars().enumerate() {
        if utf16 == offset {
            return Ok(scalar);
        }
        utf16 += ch.len_utf16() as u32;
        if utf16 > offset {
            return Err("selection splits a UTF-16 surrogate pair".into());
        }
    }
    if utf16 == offset {
        Ok(value.chars().count())
    } else {
        Err("selection lies beyond the Markdown text".into())
    }
}

fn scalar_to_utf16(value: &str, position: usize) -> Result<u32, String> {
    if position > value.chars().count() {
        return Err("selection lies beyond the Markdown text".into());
    }
    value.chars().take(position).try_fold(0_u32, |total, ch| {
        total
            .checked_add(ch.len_utf16() as u32)
            .ok_or_else(|| "Markdown selection is too large".to_string())
    })
}

fn boundary_cursor(
    doc: &Automerge,
    body: &ObjId,
    position: usize,
    movement: MoveCursor,
) -> Result<Cursor, String> {
    let length = doc.length(body);
    match position {
        0 => doc
            .get_cursor(body, CursorPosition::Start, None)
            .map_err(err),
        p if p == length => doc.get_cursor(body, CursorPosition::End, None).map_err(err),
        p => doc.get_cursor_moving(body, p, None, movement).map_err(err),
    }
}

#[cfg(target_arch = "wasm32")]
mod service {
    use super::bindings::polyvisor::app::history;

    pub async fn read() -> Result<(u64, Vec<u8>), String> {
        let snapshot = history::read().await?;
        Ok((snapshot.revision, snapshot.bytes))
    }

    pub async fn watch(after: u64) -> Result<(u64, Vec<u8>), String> {
        let snapshot = history::watch(after).await?;
        Ok((snapshot.revision, snapshot.bytes))
    }

    pub async fn publish(changes: Vec<Vec<u8>>) -> Result<(), String> {
        history::publish(changes).await
    }
}

#[cfg(target_arch = "wasm32")]
fn fresh_actor() -> ActorId {
    ActorId::random()
}

#[cfg(not(target_arch = "wasm32"))]
mod service {
    pub async fn read() -> Result<(u64, Vec<u8>), String> {
        std::future::pending().await
    }
    pub async fn watch(_: u64) -> Result<(u64, Vec<u8>), String> {
        std::future::pending().await
    }
    pub async fn publish(_: Vec<Vec<u8>>) -> Result<(), String> {
        Ok(())
    }
}

#[cfg(not(target_arch = "wasm32"))]
fn fresh_actor() -> ActorId {
    ActorId::from(&[1_u8][..])
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Pane {
    Edit,
    Preview,
}

fn set_progress(mut status: Signal<String>, failed: Signal<bool>, message: &str) {
    if !*failed.peek() {
        status.set(message.to_owned());
    }
}

fn selection_snapshot_is_stable(composing: bool, state: &TextControlState) -> bool {
    !composing && !state.is_composing
}

fn consume_composition_echo(
    completed: &mut Option<TextControlState>,
    input: &TextControlState,
) -> bool {
    completed.take().as_ref() == Some(input)
}

pub fn app() -> Element {
    let document = use_signal(|| Rc::new(RefCell::new(MarkdownDocument::new(fresh_actor()))));
    let mut revision = use_signal(|| 0_u64);
    let mut generation = use_signal(|| 0_u64);
    let mut pane = use_signal(|| Pane::Edit);
    let mut status = use_signal(|| "Loading…".to_string());
    let mut ready = use_signal(|| false);
    let mut failed = use_signal(|| false);
    let mut composing = use_signal(|| false);
    let deferred_ime = use_signal(|| Rc::new(RefCell::new(None::<Vec<u8>>)));
    let completed_composition = use_signal(|| Rc::new(RefCell::new(None::<TextControlState>)));
    let mut pending = use_signal(|| 0_usize);
    let publisher = use_coroutine(
        move |mut batches: UnboundedReceiver<Vec<Vec<u8>>>| async move {
            while let Some(batch) = batches.next().await {
                if let Err(error) = service::publish(batch).await {
                    failed.set(true);
                    status.set(format!("Save failed: {error}"));
                    return;
                }
                let remaining = pending().saturating_sub(1);
                pending.set(remaining);
                if remaining == 0 {
                    set_progress(status, failed, "Saved");
                }
            }
        },
    );

    use_future(move || async move {
        match service::read().await {
            Ok((rev, bytes)) => {
                let result = document.peek().borrow_mut().merge_snapshot(&bytes);
                match result {
                    Ok(remote_has_genesis) => {
                        revision.set(rev);
                        ready.set(true);
                        generation += 1;
                        if remote_has_genesis {
                            set_progress(status, failed, "Saved");
                        } else {
                            pending += 1;
                            set_progress(status, failed, "Saving…");
                            publisher.send(document.peek().borrow().genesis.clone());
                        }
                    }
                    Err(error) => {
                        failed.set(true);
                        status.set(format!("Load failed: {error}"));
                    }
                }
            }
            Err(error) => {
                failed.set(true);
                status.set(format!("Load failed: {error}"));
            }
        }
    });

    use_future(move || async move {
        loop {
            match service::watch(revision()).await {
                Ok((rev, bytes)) if rev > revision() => {
                    revision.set(rev);
                    if *composing.peek() {
                        // Composition owns the browser's transient value.
                        // Keep only the newest full snapshot and merge it when
                        // compositionend supplies the final synchronous value.
                        *deferred_ime.peek().borrow_mut() = Some(bytes);
                        continue;
                    }
                    match document.peek().borrow_mut().merge_snapshot(&bytes) {
                        Ok(_) => {
                            generation += 1;
                        }
                        Err(error) => {
                            failed.set(true);
                            status.set(format!("Sync failed: {error}"));
                            return;
                        }
                    }
                }
                Ok(_) => {}
                Err(error) => {
                    if !failed() {
                        failed.set(true);
                        status.set(format!("Sync stopped: {error}"));
                    }
                    return;
                }
            }
        }
    });

    let control = {
        let _ = generation();
        document.peek().borrow().control_state()
    };
    let mut enqueue = move |changes: Result<Vec<Vec<u8>>, String>| match changes {
        Ok(changes) if !changes.is_empty() => {
            pending += 1;
            set_progress(status, failed, "Saving…");
            publisher.send(changes);
            generation += 1;
        }
        Ok(_) => {}
        Err(error) => {
            failed.set(true);
            status.set(format!("Edit failed: {error}"));
        }
    };

    rsx! {
        link { rel: "stylesheet", href: APP_CSS }
        main { class: "markdown-app",
            header { class: "toolbar",
                h1 { "Markdown" }
                div { class: "tabs",
                    button { r#type: "button", onclick: move |_| pane.set(Pane::Edit), "Edit" }
                    button { r#type: "button", onclick: move |_| pane.set(Pane::Preview), "Preview" }
                }
                span { class: if failed() { "status error" } else { "status" }, role: "status", "{status}" }
            }
            if let Ok(control) = control {
                div { class: if pane() == Pane::Edit { "panes show-edit" } else { "panes show-preview" },
                    textarea {
                        class: "source",
                        aria_label: "Markdown source",
                        readonly: !ready() || failed(),
                        "text_control_state": text_control_state(control.clone()),
                        onselect: move |event: SelectionEvent| {
                            if let Some(state) = event.data().text_control()
                                && selection_snapshot_is_stable(*composing.peek(), state)
                                && let Err(error) = document.peek().borrow_mut().capture_selection(state)
                            {
                                failed.set(true);
                                status.set(format!("Selection failed: {error}"));
                            }
                        },
                        onselectionchange: move |event: SelectionEvent| {
                            if let Some(state) = event.data().text_control()
                                && selection_snapshot_is_stable(*composing.peek(), state)
                                && let Err(error) = document.peek().borrow_mut().capture_selection(state)
                            {
                                failed.set(true);
                                status.set(format!("Selection failed: {error}"));
                            }
                        },
                        oncompositionstart: move |_event: CompositionEvent| {
                            composing.set(true);
                            completed_composition.peek().borrow_mut().take();
                        },
                        oncompositionend: move |event: CompositionEvent| {
                            composing.set(false);
                            let final_state = event.data().text_control().cloned();
                            *completed_composition.peek().borrow_mut() = final_state.clone();
                            let result = final_state
                                .as_ref()
                                .ok_or_else(|| "compositionend omitted text-control state".to_string())
                                .and_then(|state| document.peek().borrow_mut().input(state));
                            enqueue(result);
                            let snapshot = deferred_ime.peek().borrow_mut().take();
                            if let Some(bytes) = snapshot {
                                match document.peek().borrow_mut().merge_snapshot(&bytes) {
                                    Ok(_) => generation += 1,
                                    Err(error) => {
                                        failed.set(true);
                                        status.set(format!("Sync failed: {error}"));
                                    }
                                }
                            }
                        },
                        oninput: {
                            move |event: FormEvent| {
                                if let Some(state) = event.data().text_control() {
                                    if !state.is_composing && !*composing.peek() {
                                        // Browsers dispatch one final input after
                                        // compositionend. That state was already
                                        // authored synchronously above, before the
                                        // deferred remote snapshot was merged. Only
                                        // the identical snapshot is that duplicate;
                                        // a browser may omit it, making the next
                                        // ordinary keystroke necessarily different.
                                        if consume_composition_echo(
                                            &mut completed_composition.peek().borrow_mut(),
                                            state,
                                        ) {
                                            return;
                                        }
                                        enqueue(document.peek().borrow_mut().input(state));
                                    }
                                } else {
                                    failed.set(true);
                                    status.set("Edit failed: input event omitted text-control state".into());
                                }
                            }
                        },
                    }
                    section { class: "preview", aria_label: "Markdown preview", {render_markdown(&control.value)} }
                }
            }
        }
    }
}

#[derive(Clone, PartialEq)]
enum MarkdownNode {
    Container(MarkdownTag, Vec<MarkdownNode>),
    Text(String),
    Code(String),
    Break,
    Rule,
}

#[derive(Clone, Copy, PartialEq)]
enum MarkdownTag {
    Paragraph,
    Heading(HeadingLevel),
    Quote,
    CodeBlock,
    Ul,
    Ol,
    Item,
    Em,
    Strong,
    Other,
}

fn render_markdown(source: &str) -> Element {
    let mut stack = vec![(MarkdownTag::Other, Vec::new())];
    for event in Parser::new_ext(source, Options::all()) {
        match event {
            Event::Start(tag) => stack.push((markdown_tag(&tag), Vec::new())),
            Event::End(_) => {
                if let Some((tag, children)) = stack.pop()
                    && let Some((_, parent)) = stack.last_mut()
                {
                    parent.push(MarkdownNode::Container(tag, children));
                }
            }
            Event::Text(text)
            | Event::Html(text)
            | Event::InlineHtml(text)
            | Event::InlineMath(text)
            | Event::DisplayMath(text) => stack
                .last_mut()
                .unwrap()
                .1
                .push(MarkdownNode::Text(text.into_string())),
            Event::Code(text) => stack
                .last_mut()
                .unwrap()
                .1
                .push(MarkdownNode::Code(text.into_string())),
            Event::SoftBreak | Event::HardBreak => {
                stack.last_mut().unwrap().1.push(MarkdownNode::Break)
            }
            Event::Rule => stack.last_mut().unwrap().1.push(MarkdownNode::Rule),
            Event::TaskListMarker(done) => stack
                .last_mut()
                .unwrap()
                .1
                .push(MarkdownNode::Text(if done { "☑ " } else { "☐ " }.into())),
            Event::FootnoteReference(text) => stack
                .last_mut()
                .unwrap()
                .1
                .push(MarkdownNode::Text(format!("[{text}]"))),
        }
    }
    let nodes = stack.pop().unwrap().1;
    rsx! { for node in nodes { MarkdownView { node } } }
}

fn markdown_tag(tag: &Tag<'_>) -> MarkdownTag {
    match tag {
        Tag::Paragraph => MarkdownTag::Paragraph,
        Tag::Heading { level, .. } => MarkdownTag::Heading(*level),
        Tag::BlockQuote(_) => MarkdownTag::Quote,
        Tag::CodeBlock(_) => MarkdownTag::CodeBlock,
        Tag::List(Some(_)) => MarkdownTag::Ol,
        Tag::List(None) => MarkdownTag::Ul,
        Tag::Item => MarkdownTag::Item,
        Tag::Emphasis => MarkdownTag::Em,
        Tag::Strong => MarkdownTag::Strong,
        _ => MarkdownTag::Other,
    }
}

#[component]
fn MarkdownView(node: MarkdownNode) -> Element {
    match node {
        MarkdownNode::Text(text) => rsx! { "{text}" },
        MarkdownNode::Code(text) => rsx! { code { "{text}" } },
        MarkdownNode::Break => rsx! { br {} },
        MarkdownNode::Rule => rsx! { hr {} },
        MarkdownNode::Container(tag, children) => {
            let content = rsx! { for child in children { MarkdownView { node: child } } };
            match tag {
                MarkdownTag::Paragraph => rsx! { p { {content} } },
                MarkdownTag::Heading(HeadingLevel::H1) => rsx! { h1 { {content} } },
                MarkdownTag::Heading(HeadingLevel::H2) => rsx! { h2 { {content} } },
                MarkdownTag::Heading(HeadingLevel::H3) => rsx! { h3 { {content} } },
                MarkdownTag::Heading(HeadingLevel::H4) => rsx! { h4 { {content} } },
                MarkdownTag::Heading(HeadingLevel::H5) => rsx! { h5 { {content} } },
                MarkdownTag::Heading(HeadingLevel::H6) => rsx! { h6 { {content} } },
                MarkdownTag::Quote => rsx! { q { {content} } },
                MarkdownTag::CodeBlock => rsx! { pre { {content} } },
                MarkdownTag::Ul => rsx! { ul { {content} } },
                MarkdownTag::Ol => rsx! { ol { {content} } },
                MarkdownTag::Item => rsx! { li { {content} } },
                MarkdownTag::Em => rsx! { em { {content} } },
                MarkdownTag::Strong => rsx! { strong { {content} } },
                MarkdownTag::Other => rsx! { span { {content} } },
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::{Digest, Sha256};

    fn doc(actor: u8) -> MarkdownDocument {
        MarkdownDocument::new(ActorId::from(&[actor][..]))
    }

    #[test]
    fn genesis_is_identical_and_creates_one_text_object() {
        let left = doc(1);
        let right = doc(2);
        assert_eq!(left.genesis, right.genesis);
        assert_eq!(left.body, right.body);
        assert_eq!(left.control_state().unwrap().value, "");
    }

    #[test]
    fn unicode_input_and_backward_selection_round_trip() {
        let mut document = doc(1);
        document.edit_text("A💡BC").unwrap();
        document
            .capture_selection(&TextControlState {
                value: "A💡BC".into(),
                selection_start: 1,
                selection_end: 4,
                direction: TextControlSelectionDirection::Backward,
                is_composing: false,
            })
            .unwrap();

        let state = document.control_state().unwrap();
        assert_eq!((state.selection_start, state.selection_end), (1, 4));
        assert_eq!(state.direction, TextControlSelectionDirection::Backward);

        document
            .input(&TextControlState {
                value: "AXC".into(),
                selection_start: 2,
                selection_end: 2,
                direction: TextControlSelectionDirection::None,
                is_composing: false,
            })
            .unwrap();
        let state = document.control_state().unwrap();
        assert_eq!(state.value, "AXC");
        assert_eq!((state.selection_start, state.selection_end), (2, 2));
    }

    #[test]
    fn stable_selection_moves_across_remote_unicode_insert() {
        let mut local = doc(1);
        local.edit_text("A💡BC").unwrap();
        local
            .capture_selection(&TextControlState {
                value: "A💡BC".into(),
                selection_start: 1,
                selection_end: 4,
                direction: TextControlSelectionDirection::Backward,
                is_composing: false,
            })
            .unwrap();
        let mut remote = MarkdownDocument::from_snapshot(&local.doc.save(), 2).unwrap();
        remote.edit_text("🌍A💡BC").unwrap();
        local.merge_snapshot(&remote.doc.save()).unwrap();

        let state = local.control_state().unwrap();
        assert_eq!(state.value, "🌍A💡BC");
        assert_eq!((state.selection_start, state.selection_end), (3, 6));
        assert_eq!(state.direction, TextControlSelectionDirection::Backward);
    }

    #[test]
    fn deleted_selection_anchors_resolve_to_surviving_boundaries() {
        let mut local = doc(1);
        local.edit_text("abcdef").unwrap();
        local
            .capture_selection(&TextControlState {
                value: "abcdef".into(),
                selection_start: 2,
                selection_end: 4,
                direction: TextControlSelectionDirection::Forward,
                is_composing: false,
            })
            .unwrap();
        let mut remote = MarkdownDocument::from_snapshot(&local.doc.save(), 2).unwrap();
        remote.edit_text("abf").unwrap();
        local.merge_snapshot(&remote.doc.save()).unwrap();

        let state = local.control_state().unwrap();
        assert_eq!(state.value, "abf");
        assert_eq!((state.selection_start, state.selection_end), (2, 2));
    }

    #[test]
    fn composition_sequence_ignores_transient_selection_and_only_matching_echo() {
        let transient = TextControlState {
            value: "に".into(),
            selection_start: 1,
            selection_end: 1,
            direction: TextControlSelectionDirection::None,
            is_composing: true,
        };
        assert!(!selection_snapshot_is_stable(true, &transient));
        assert!(!selection_snapshot_is_stable(false, &transient));

        let completed = TextControlState {
            value: "日本".into(),
            selection_start: 2,
            selection_end: 2,
            direction: TextControlSelectionDirection::None,
            is_composing: false,
        };
        let mut marker = Some(completed.clone());
        assert!(consume_composition_echo(&mut marker, &completed));
        assert!(marker.is_none());

        // If no duplicate final input arrives, the next real keystroke does
        // not match and must be processed; checking also consumes the marker.
        let mut marker = Some(completed);
        let ordinary = TextControlState {
            value: "日本語".into(),
            selection_start: 3,
            selection_end: 3,
            direction: TextControlSelectionDirection::None,
            is_composing: false,
        };
        assert!(!consume_composition_echo(&mut marker, &ordinary));
        assert!(marker.is_none());
        assert!(selection_snapshot_is_stable(false, &ordinary));
    }

    #[test]
    fn manifest_asset_handles_match_bytes() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
        let manifest: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(dir.join("manifest.json")).unwrap())
                .unwrap();
        for asset in manifest["assets"].as_array().unwrap() {
            let path = asset["path"].as_str().unwrap();
            let digest = format!(
                "{:x}",
                Sha256::digest(std::fs::read(dir.join("assets").join(path)).unwrap())
            );
            assert_eq!(asset["handle"].as_str().unwrap(), digest);
        }
    }
}
