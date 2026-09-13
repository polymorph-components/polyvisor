//! Explicit root-custody transfer over its own authenticated encrypted ALPN.

use ed25519_dalek::SigningKey;

use crate::{EngineTransport, Error, ErrorCode, Kernel, ROOT_TRANSFER_ALPN, engine_failed};

const TRANSFER: u8 = 1;
const PERSISTED: u8 = 2;
const RECEIVED: u8 = 3;
const REFUSED: u8 = 4;
const TRANSFER_LEN: usize = 1 + 32 + 32 + 32;
const MAX_FRAME: usize = TRANSFER_LEN;
const TIMEOUT_MS: u64 = 120_000;

enum Frame {
    Transfer {
        root: [u8; 32],
        group: [u8; 32],
        seed: [u8; 32],
    },
    Persisted,
    Received,
    Refused,
}

impl Kernel {
    /// Copy root custody to a currently enrolled, explicitly named endpoint.
    /// Success means the recipient checkpointed the seed before acknowledging.
    pub async fn root_transfer(&self, endpoint_id: String) -> Result<(), Error> {
        self.identity_open()?;
        let target = self.member_key_for_endpoint(&endpoint_id).await?;
        if target == self.engine()?.verifying_key().to_bytes() {
            return Err(Error::new(
                ErrorCode::Refused,
                "root custody is already on this device",
            ));
        }
        let before = self.identity_status().await?;
        let context = self.identity_context();
        let endpoint = self.endpoint.borrow().clone().ok_or_else(|| {
            Error::new(ErrorCode::Unavailable, "this device endpoint is not ready")
        })?;
        let connect = endpoint.connect(endpoint_id, ROOT_TRANSFER_ALPN.into());
        let (peer, transport) =
            match futures::future::select(connect, self.seams.clock.sleep(TIMEOUT_MS)).await {
                futures::future::Either::Left((Ok(connection), _)) => connection,
                futures::future::Either::Left((Err(why), _)) => {
                    return Err(Error::new(ErrorCode::Failed, why));
                }
                futures::future::Either::Right(_) => {
                    return Err(Error::new(ErrorCode::Failed, "root transfer timed out"));
                }
            };

        // Everything after connect runs under one close guard. In particular,
        // membership, identity, send, receive, and final validation failures
        // cannot leak a live secret-bearing transport.
        let result = async {
            if peer != target {
                return Err(Error::new(
                    ErrorCode::Refused,
                    "a different device answered the selected endpoint",
                ));
            }
            self.require_current_member(peer).await?;
            let identity = self.identity_status().await?;
            if !self.identity_context_is(context) {
                return Err(Error::new(
                    ErrorCode::Refused,
                    "the user identity changed during transfer",
                ));
            }
            require_same_identity(before, identity)?;
            let seed = self.require_root_seed()?;
            timed(
                self.seams.clock.as_ref(),
                send(
                    transport.as_ref(),
                    &Frame::Transfer {
                        root: identity.root,
                        group: identity.group,
                        seed,
                    },
                ),
            )
            .await?
            .map_err(|why| Error::new(ErrorCode::Failed, why))?;
            match timed(self.seams.clock.as_ref(), receive(transport.as_ref())).await? {
                Some(Frame::Persisted) => {
                    if !self.identity_context_is(context) {
                        return Err(Error::new(
                            ErrorCode::Refused,
                            "the user identity changed during transfer",
                        ));
                    }
                    require_same_identity(before, self.identity_status().await?)?;
                    self.require_current_member(peer).await?;
                    timed(
                        self.seams.clock.as_ref(),
                        send(transport.as_ref(), &Frame::Received),
                    )
                    .await?
                    .map_err(|why| Error::new(ErrorCode::Failed, why))?;
                    Ok(())
                }
                Some(Frame::Refused) => Err(Error::new(
                    ErrorCode::Refused,
                    "the recipient refused root custody",
                )),
                _ => Err(Error::new(
                    ErrorCode::Failed,
                    "the recipient did not acknowledge persisted root custody",
                )),
            }
        }
        .await;
        transport.close().await;
        result
    }

    pub(crate) async fn root_transfer_accept(
        &self,
        sender: [u8; 32],
        transport: Box<dyn EngineTransport>,
    ) {
        // Only network waits are bounded. In particular the durable checkpoint
        // inside `receive_root_transfer` must run to completion: dropping that
        // future would leave the checkpoint gate latched and custody installed.
        let outcome = self.receive_root_transfer(sender, transport.as_ref()).await;
        let reply = if outcome.is_ok() {
            Frame::Persisted
        } else {
            Frame::Refused
        };
        let sent = timed(self.seams.clock.as_ref(), send(transport.as_ref(), &reply)).await;
        if outcome.is_ok() && matches!(sent, Ok(Ok(()))) {
            // A receipt proves the sender consumed Persisted before either
            // side closes; otherwise QUIC close may overtake the final frame.
            let _receipt = timed(self.seams.clock.as_ref(), receive(transport.as_ref())).await;
        }
        transport.close().await;
    }

    async fn receive_root_transfer(
        &self,
        sender: [u8; 32],
        transport: &dyn EngineTransport,
    ) -> Result<(), Error> {
        self.identity_open()?;
        self.require_current_member(sender).await?;
        let before = self.identity_status().await?;
        let context = self.identity_context();
        let Some(Frame::Transfer { root, group, seed }) =
            timed(self.seams.clock.as_ref(), receive(transport)).await?
        else {
            return Err(Error::new(
                ErrorCode::Refused,
                "invalid root transfer frame",
            ));
        };
        self.require_current_member(sender).await?;
        let identity = self.identity_status().await?;
        if !self.identity_context_is(context) {
            return Err(Error::new(
                ErrorCode::Refused,
                "the user identity changed during transfer",
            ));
        }
        require_same_identity(before, identity)?;
        if root != identity.root
            || group != identity.group
            || SigningKey::from_bytes(&seed).verifying_key().to_bytes() != root
        {
            return Err(Error::new(
                ErrorCode::Refused,
                "transferred custody does not match this user's identity",
            ));
        }
        let previous = self.root_seed();
        self.install_root_seed(seed)?;
        if let Err(error) = self.checkpoint_durable().await {
            if self.identity_context_is(context) {
                self.replace_root_seed(previous)?;
                // The failed pass completed and unlatched the writer before
                // returning. Persist the rollback so a later successful
                // mutation cannot serialize the rejected custody.
                let _rollback = self.checkpoint_durable().await;
            }
            return Err(error);
        }
        if !self.identity_context_is(context) {
            return Err(Error::new(
                ErrorCode::Refused,
                "the user identity changed during transfer",
            ));
        }
        self.push_event(crate::Event::ContactsChanged);
        Ok(())
    }

    async fn member_key_for_endpoint(&self, endpoint: &str) -> Result<[u8; 32], Error> {
        self.engine()?
            .authority_members()
            .await
            .map_err(engine_failed)?
            .into_iter()
            .find(|key| self.seams.net.endpoint_id(*key) == endpoint)
            .ok_or_else(|| Error::new(ErrorCode::Refused, "that endpoint is not a current member"))
    }

    async fn require_current_member(&self, key: [u8; 32]) -> Result<(), Error> {
        if self
            .engine()?
            .authority_members()
            .await
            .map_err(engine_failed)?
            .contains(&key)
        {
            Ok(())
        } else {
            Err(Error::new(
                ErrorCode::Refused,
                "that device is not a current member",
            ))
        }
    }
}

fn require_same_identity(
    before: crate::IdentityStatus,
    after: crate::IdentityStatus,
) -> Result<(), Error> {
    if before.root == after.root && before.group == after.group {
        Ok(())
    } else {
        Err(Error::new(
            ErrorCode::Refused,
            "the user identity changed during transfer",
        ))
    }
}

async fn timed<F: std::future::Future>(
    clock: &dyn crate::Clock,
    future: F,
) -> Result<F::Output, Error> {
    match futures::future::select(Box::pin(future), clock.sleep(TIMEOUT_MS)).await {
        futures::future::Either::Left((output, _)) => Ok(output),
        futures::future::Either::Right(_) => {
            Err(Error::new(ErrorCode::Failed, "root transfer timed out"))
        }
    }
}

async fn send(transport: &dyn EngineTransport, frame: &Frame) -> Result<(), String> {
    let bytes = encode(frame);
    debug_assert!(bytes.len() <= MAX_FRAME);
    transport.send(bytes).await
}

async fn receive(transport: &dyn EngineTransport) -> Option<Frame> {
    let bytes = transport.recv().await?;
    (bytes.len() <= MAX_FRAME).then(|| decode(&bytes)).flatten()
}

fn encode(frame: &Frame) -> Vec<u8> {
    match frame {
        Frame::Transfer { root, group, seed } => {
            let mut bytes = Vec::with_capacity(TRANSFER_LEN);
            bytes.push(TRANSFER);
            bytes.extend_from_slice(root);
            bytes.extend_from_slice(group);
            bytes.extend_from_slice(seed);
            bytes
        }
        Frame::Persisted => vec![PERSISTED],
        Frame::Received => vec![RECEIVED],
        Frame::Refused => vec![REFUSED],
    }
}

fn decode(bytes: &[u8]) -> Option<Frame> {
    match bytes {
        [PERSISTED] => Some(Frame::Persisted),
        [RECEIVED] => Some(Frame::Received),
        [REFUSED] => Some(Frame::Refused),
        [TRANSFER, body @ ..] if body.len() == TRANSFER_LEN - 1 => Some(Frame::Transfer {
            root: body[..32].try_into().ok()?,
            group: body[32..64].try_into().ok()?,
            seed: body[64..].try_into().ok()?,
        }),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn transfer_frame_is_fixed_size_and_exactly_decoded() {
        let bytes = encode(&Frame::Transfer {
            root: [u8::MAX; 32],
            group: [u8::MAX; 32],
            seed: [u8::MAX; 32],
        });
        assert_eq!(bytes.len(), 97);
        assert!(matches!(decode(&bytes), Some(Frame::Transfer { .. })));
        assert!(decode(&bytes[..96]).is_none());
        let mut oversized = bytes;
        oversized.push(0);
        assert!(decode(&oversized).is_none());
    }
}
