//! Dedicated backup-v1 Argon2 component.
//!
//! It intentionally exposes only passphrase + salt and returns only the
//! derived key. Envelope policy, root material, and KDF costs remain in the
//! kernel (`root_backup.rs`).

#[cfg(target_arch = "wasm32")]
mod component {
    wit_bindgen::generate!({
        path: "wit",
        world: "kdf-worker",
    });

    struct Component;

    impl exports::polyvisor::backup_kdf::backup_kdf::Guest for Component {
        fn derive(passphrase: String, salt: Vec<u8>) -> Result<Vec<u8>, String> {
            let salt: [u8; polyvisor_kernel::ROOT_BACKUP_SALT_LEN] = salt
                .try_into()
                .map_err(|_| "backup salt has the wrong length".to_string())?;
            // Delegate to the kernel's sole backup-v1 implementation so the
            // component cannot drift from envelope costs or algorithm choice.
            let key = polyvisor_kernel::derive_backup_key(&passphrase, &salt)
                .map_err(|_| "key derivation failed".to_string())?;
            Ok(key.as_bytes().to_vec())
        }
    }

    export!(Component);
}
