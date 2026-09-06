//! The trusted pixels: the strip, and the drawer behind it.
//!
//! The strip is the trust anchor — always present, fixed height, and the
//! only place the device identity is shown. The drawer is everything that
//! needs room: the app list and the device settings. Both are rendered by
//! this one component so there is exactly one tree, and no ordering
//! question about which of them the receiver mounts first.
//!
//! The visor holds no state of its own beyond what is on screen right now
//! (docs/design.md "Visor and apps render through stream-dom"): identity,
//! hue, word and the app list are kernel state, read at mount and re-read
//! only when the visor itself changed them.

use dioxus::prelude::*;

use crate::kernel::{self, App, Event, SessionId, Status};
use crate::state::{Action, Drawer, Tenant};
use crate::style::CSS;
use crate::voice::{AppText, AppVoice, Voice};

/// What the strip says when nothing is running. Two shapes because a
/// session ending is framework voice with the app's *title* plated — the
/// one place the two voices share a sentence.
#[derive(Clone, PartialEq)]
enum Notice {
    Plain(String),
    Ended { app: AppText, reason: String },
}

#[component]
pub(crate) fn Visor() -> Element {
    let mut drawer = use_signal(Drawer::default);
    let mut status = use_signal(|| None::<Status>);
    let mut apps = use_signal(Vec::<App>::new);
    let mut session = use_signal(|| None::<(SessionId, App)>);
    let mut notice = use_signal(|| None::<Notice>);

    // Everything the strip shows is kernel state; this is the one read.
    use_future(move || async move {
        match kernel::status().await {
            Ok(s) => status.set(Some(s)),
            Err(e) => notice.set(Some(Notice::Plain(e))),
        }
        match kernel::installed().await {
            Ok(list) => apps.set(list),
            Err(e) => notice.set(Some(Notice::Plain(e))),
        }
    });

    // The long poll. A session ending here is one the visor did not ask
    // for (`apps.close` emits nothing), so it always has something to say.
    use_future(move || async move {
        loop {
            let Event::SessionEnded(ended, reason) = kernel::next_event().await;
            let current = session.read().as_ref().map(|(id, app)| (*id, app.clone()));
            if let Some((id, app)) = current
                && id == ended
            {
                let _ = kernel::close_frame(id).await;
                session.set(None);
                notice.set(Some(Notice::Ended {
                    app: app.title,
                    reason,
                }));
            }
        }
    });

    let open = move |app: App| async move {
        match kernel::launch(&app.id).await {
            Err(e) => notice.set(Some(Notice::Plain(e))),
            Ok(id) => match kernel::open_frame(id).await {
                Ok(()) => {
                    notice.set(None);
                    session.set(Some((id, app)));
                    // The frame gets the screen; the drawer never covers it.
                    drawer.set(drawer().reduce(Action::Close));
                }
                Err(e) => {
                    // The session outlived the frame that was to show it;
                    // leaving it live would leak a session id per failure.
                    let _ = kernel::close(id).await;
                    notice.set(Some(Notice::Plain(e)));
                }
            },
        }
    };

    let close_session = move |id: SessionId| async move {
        let _ = kernel::close_frame(id).await;
        if let Err(e) = kernel::close(id).await {
            notice.set(Some(Notice::Plain(e)));
        }
        session.set(None);
        drawer.set(drawer().reduce(Action::Close));
    };

    let live = session.read().as_ref().map(|(id, app)| (*id, app.clone()));
    let tenant = drawer().tenant();

    rsx! {
        // The trusted pixels depend on nothing the page provides, so the
        // visor ships its own stylesheet as part of its own tree.
        style { "{CSS}" }

        div { id: "visor-strip",
            Identity { status: status.read().as_ref().map(Anchor::of) }
            div { id: "visor-context",
                match (&live, &*notice.read()) {
                    (Some((_, app)), _) => rsx! {
                        span { class: "{Voice::Framework.class()}", "showing " }
                        AppVoice { text: app.title.clone() }
                    },
                    (None, Some(Notice::Ended { app, reason })) => rsx! {
                        AppVoice { text: app.clone() }
                        span { class: "{Voice::Framework.class()}", " ended: {reason}" }
                    },
                    (None, Some(Notice::Plain(message))) => rsx! {
                        span { class: "{Voice::Framework.class()}", "{message}" }
                    },
                    (None, None) => rsx! {
                        span { class: "{Voice::Framework.class()}", "nothing is running" }
                    },
                }
            }
            div { id: "visor-actions",
                TenantButton { label: "Apps", tenant: Tenant::Apps, open: tenant == Some(Tenant::Apps),
                    onpress: move |t| drawer.set(drawer().reduce(Action::Toggle(t))) }
                TenantButton { label: "Settings", tenant: Tenant::Settings, open: tenant == Some(Tenant::Settings),
                    onpress: move |t| drawer.set(drawer().reduce(Action::Toggle(t))) }
                if let Some((id, _)) = live {
                    button { onclick: move |_| async move { close_session(id).await }, "Close" }
                }
            }
        }

        if let Some(tenant) = tenant {
            div { id: "visor-drawer",
                match tenant {
                    Tenant::Apps => rsx! {
                        for app in apps.read().iter().cloned() {
                            div { key: "{app.id}", class: "app-row",
                                div { class: "app-row-title", AppVoice { text: app.title.clone() } }
                                button {
                                    onclick: move |_| { let app = app.clone(); async move { open(app).await } },
                                    "Open"
                                }
                            }
                        }
                        if apps.read().is_empty() {
                            span { class: "{Voice::Framework.class()}", "no apps are installed" }
                        }
                    },
                    Tenant::Settings => rsx! {
                        label {
                            span { class: "{Voice::Framework.class()}", "name" }
                            input {
                                r#type: "text",
                                value: status.read().as_ref().map(|s| s.name.clone()).unwrap_or_default(),
                                onchange: move |e| async move {
                                    let name = e.value();
                                    match kernel::set_name(name.clone()).await {
                                        Ok(()) => status.with_mut(|s| { if let Some(s) = s { s.name = name } }),
                                        Err(e) => notice.set(Some(Notice::Plain(e))),
                                    }
                                },
                            }
                        }
                        label {
                            span { class: "{Voice::Framework.class()}", "colour" }
                            input {
                                r#type: "range", min: "0", max: "359",
                                value: "{status.read().as_ref().map(|s| s.hue).unwrap_or(0)}",
                                onchange: move |e| async move {
                                    let Ok(hue) = e.value().parse::<u16>() else { return };
                                    match kernel::set_hue(hue).await {
                                        Ok(()) => status.with_mut(|s| { if let Some(s) = s { s.hue = hue } }),
                                        Err(e) => notice.set(Some(Notice::Plain(e))),
                                    }
                                },
                            }
                        }
                        label {
                            span { class: "{Voice::Framework.class()}", "word" }
                            span { class: "{Voice::Framework.class()}", "{status.read().as_ref().map(|s| s.word.clone()).unwrap_or_default()}" }
                            button {
                                onclick: move |_| async move {
                                    match kernel::reroll_word().await {
                                        Ok(word) => status.with_mut(|s| { if let Some(s) = s { s.word = word } }),
                                        Err(e) => notice.set(Some(Notice::Plain(e))),
                                    }
                                },
                                "Reroll"
                            }
                        }
                    },
                }
            }
        }
    }
}

/// The identity as the strip draws it. A plain value so `Identity` is a
/// pure function of it and re-renders only when the identity changed.
#[derive(Clone, PartialEq)]
struct Anchor {
    name: String,
    hue: u16,
}

impl Anchor {
    fn of(status: &Status) -> Anchor {
        Anchor {
            name: status.name.clone(),
            hue: status.hue,
        }
    }
}

#[component]
fn Identity(status: Option<Anchor>) -> Element {
    let Some(anchor) = status else {
        return rsx! {
            div { id: "visor-identity",
                span { class: "{Voice::Framework.class()}", "waking" }
            }
        };
    };
    rsx! {
        div { id: "visor-identity",
            // Per-element, not a theme variable: the hue is this device's
            // identity, and identity does not cascade.
            div { id: "visor-circle", style: "background: hsl({anchor.hue}deg 65% 50%)" }
            if anchor.name.is_empty() {
                span { class: "{Voice::Framework.class()} placeholder", "this device" }
            } else {
                span { class: "{Voice::User.class()}", "{anchor.name}" }
            }
            // The anchor word is a recognition secret between the user and
            // this device: spoken only in the settings sheet, on request,
            // never left standing in the strip.
        }
    }
}

/// A strip button that opens its tenant. `aria-pressed` is the open state
/// the stylesheet keys off, so pressed-ness is one fact, not two.
#[component]
fn TenantButton(
    label: String,
    tenant: Tenant,
    open: bool,
    onpress: EventHandler<Tenant>,
) -> Element {
    rsx! {
        button {
            aria_pressed: "{open}",
            onclick: move |_| onpress.call(tenant),
            "{label}"
        }
    }
}
