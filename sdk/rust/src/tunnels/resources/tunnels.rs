//! Control-plane reads + update + sign-csr for tunnels.
//!
//! Ported from `inkbox/tunnels/resources/tunnels.py`. Tunnels are created and
//! deleted exclusively via identity-create / identity-delete cascades; there
//! is no standalone create / delete / restore / force-delete / rotate-secret
//! surface.

use std::sync::{Arc, Weak};

use serde_json::{json, Value};

use crate::error::{InkboxError, Result};
use crate::http::{HttpTransport, NO_QUERY};
use crate::tunnels::exceptions::map_sign_csr_error;
use crate::tunnels::types::{SignedCert, Tunnel};

const BASE: &str = "/tunnels";

/// The cert issuance flow runs synchronously inside the request and can take
/// up to a few minutes; Python bumps this call's timeout well above the
/// standard one. The Rust [`HttpTransport`] does not yet expose a per-request
/// timeout override, so [`TunnelsResource::sign_csr`] issues the call on the
/// shared transport. The constant is kept for parity / future wiring.
#[allow(dead_code)]
const SIGN_CSR_TIMEOUT_SECONDS: f64 = 180.0;

/// Lower bound for the optional `pool_size` kwarg on `connect()`. Validated in
/// the data-plane connect surface, but the constant lives here so the resource
/// module is the single source of truth.
pub const POOL_SIZE_MIN: i64 = 1;
/// Upper bound for the optional `pool_size` kwarg on `connect()`.
pub const POOL_SIZE_MAX: i64 = 32;

/// Read + edit wrapper for `/api/v1/tunnels/*` plus the `connect()` data-plane
/// entry point.
///
/// Tunnel lifecycle is owned by identity-create / identity-delete; there is no
/// create / delete / restore / force-delete / rotate-secret surface here.
///
/// Holds both the HTTP transport and a back-reference to the owning
/// [`Inkbox`](crate::client::Inkbox) client (used to launch the data-plane
/// runtime). The back-ref is a [`Weak`] to avoid a reference cycle (the client
/// owns the resource).
pub struct TunnelsResource {
    http: Arc<HttpTransport>,
    /// Back-ref to the owning client; `Weak` breaks the client -> resource ->
    /// client cycle. Used only by the data-plane `connect()` path.
    #[allow(dead_code)]
    inkbox: Weak<crate::client::Inkbox>,
}

impl TunnelsResource {
    /// Construct a tunnels resource.
    ///
    /// # Arguments
    /// * `http` - The shared HTTP transport for the `/tunnels` sub-base.
    /// * `inkbox` - A weak back-reference to the owning client (used to launch
    ///   the data-plane runtime; held weakly to avoid a reference cycle).
    pub fn new(http: Arc<HttpTransport>, inkbox: Weak<crate::client::Inkbox>) -> Self {
        Self { http, inkbox }
    }

    // --- Reads -----------------------------------------------------------

    /// List all tunnels for your organisation.
    pub fn list(&self) -> Result<Vec<Tunnel>> {
        let data = self.http.get(&format!("{BASE}/"), NO_QUERY)?;
        // The server may wrap the list as `{"tunnels": [...]}` or return a bare
        // array; handle both, matching Python.
        let items: &[Value] = match &data {
            Value::Object(map) => match map.get("tunnels") {
                Some(Value::Array(arr)) => arr.as_slice(),
                _ => &[],
            },
            Value::Array(arr) => arr.as_slice(),
            _ => &[],
        };
        items.iter().map(Tunnel::from_value).collect()
    }

    /// Fetch a tunnel by id.
    ///
    /// # Arguments
    /// * `tunnel_id` - The tunnel's id (UUID or its string form).
    pub fn get(&self, tunnel_id: &str) -> Result<Tunnel> {
        let data = self.http.get(&format!("{BASE}/{tunnel_id}"), NO_QUERY)?;
        Tunnel::from_value(&data)
    }

    // --- Writes ----------------------------------------------------------

    /// Update a tunnel's metadata.
    ///
    /// `metadata` is the only mutable field on the tunnel; other attributes are
    /// derived from the owning identity.
    ///
    /// The argument is modeled `Option<Option<...>>` to mirror the Python
    /// `_UNSET` sentinel:
    /// - `None` (outer) — omit `metadata` from the body entirely (leave
    ///   unchanged).
    /// - `Some(None)` — send `metadata: null` (clears to `{}` server-side).
    /// - `Some(Some(map))` — send the given object.
    ///
    /// `Some(None)` and `Some(Some({}))` both clear to `{}`: the server's
    /// column is non-nullable and collapses both forms on the wire.
    ///
    /// # Arguments
    /// * `tunnel_id` - The tunnel's id.
    /// * `metadata` - The new metadata bag (see the sentinel semantics above).
    pub fn update(
        &self,
        tunnel_id: &str,
        metadata: Option<Option<serde_json::Map<String, Value>>>,
    ) -> Result<Tunnel> {
        // Build the body conditionally, matching Python's "omit when _UNSET".
        let mut body = serde_json::Map::new();
        if let Some(m) = metadata {
            // `metadata=None` -> JSON null; `metadata={...}` -> the object.
            body.insert(
                "metadata".to_string(),
                match m {
                    Some(map) => Value::Object(map),
                    None => Value::Null,
                },
            );
        }
        let data = self
            .http
            .patch(&format!("{BASE}/{tunnel_id}"), &Value::Object(body))?;
        Tunnel::from_value(&data)
    }

    /// Sign a CSR for a passthrough tunnel.
    ///
    /// The server performs DNS validation and cert issuance synchronously
    /// inside this request, which can take up to a few minutes. Python uses an
    /// elevated 180-second timeout for this; the Rust transport does not yet
    /// expose a per-call timeout override (see [`SIGN_CSR_TIMEOUT_SECONDS`]),
    /// so this call relies on the transport's configured timeout.
    ///
    /// # Arguments
    /// * `tunnel_id` - The tunnel's id.
    /// * `csr_pem` - PEM-encoded CSR. The CN must equal the tunnel hostname.
    pub fn sign_csr(&self, tunnel_id: &str, csr_pem: &str) -> Result<SignedCert> {
        let body = json!({ "csr_pem": csr_pem });
        match self
            .http
            .post(&format!("{BASE}/{tunnel_id}/sign-csr"), Some(&body), NO_QUERY)
        {
            // Reclassify a 409 onto the right tunnel subclass (edge/TLS-mode
            // vs CSR-state), matching Python's `_map_sign_csr_error`.
            Err(err) => Err(map_sign_csr_error(err)),
            Ok(data) => SignedCert::from_value(&data),
        }
    }

    // --- Data plane ------------------------------------------------------

    /// Bring a tunnel online from this process.
    ///
    /// Launches the data-plane runtime via the owning client. The runtime is
    /// ported separately (behind the `tunnels-runtime` feature); until it
    /// lands, this stub returns an error.
    // TODO(tunnels-runtime): wire this to the data-plane `connect` entry point
    // once `crate::tunnels::client` is ported. The Python version lazy-imports
    // `inkbox.tunnels.client.connect` and calls it with the back-ref client.
    pub fn connect(&self) -> Result<()> {
        let _ = &self.inkbox; // silence unused until the runtime is wired
        Err(InkboxError::Tunnel("runtime not yet wired".into()))
    }
}
