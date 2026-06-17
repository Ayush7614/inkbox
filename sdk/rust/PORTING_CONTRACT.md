# Rust SDK porting contract

You are porting one domain of the Inkbox Python SDK (`sdk/python/inkbox/`) to
Rust (`sdk/rust/src/`). The TypeScript SDK (`sdk/typescript/src/`) is the
secondary reference — consult it to disambiguate field names / optionality.
**The wire shape (JSON field names, enum string values, request bodies, query
params, paths) MUST match exactly.** That is the contract the server enforces.

## Core types already implemented (do NOT redefine them)

`crate::error`:
- `pub type Result<T> = std::result::Result<T, InkboxError>;`
- `InkboxError` variants: `Api{status_code,detail}`, `DuplicateContactRule{..}`,
  `RedundantContactAccessGrant{..}`, `RecipientBlocked{..}`, `VaultKey(String)`,
  `InvalidArgument(String)`, `Tunnel(String)`, `Transport(reqwest::Error)`,
  `Decode(serde_json::Error)`. Construct `InvalidArgument`/`VaultKey`/`Tunnel`
  for local validation failures the Python code raises as `ValueError`/`TypeError`.

`crate::http::HttpTransport` (resources hold `std::sync::Arc<HttpTransport>`):
- `get(&self, path: &str, params: Query) -> Result<Value>`
- `post<B: Serialize>(&self, path, body: Option<&B>, params: Query) -> Result<Value>`
- `put<B: Serialize>(&self, path, body: &B) -> Result<Value>`
- `patch<B: Serialize>(&self, path, body: &B) -> Result<Value>`
- `delete(&self, path) -> Result<()>`
- `delete_with_response(&self, path) -> Result<Value>`
- `post_multipart(&self, path, field_name, filename, content: Vec<u8>, content_type) -> Result<Value>`
- `post_bytes(&self, path, content: Vec<u8>, content_type, accept) -> Result<Value>`
- `get_bytes(&self, path, accept, params: Query) -> Result<Vec<u8>>`
- `Query<'a> = &'a [(&'a str, String)]`; `crate::http::NO_QUERY` is the empty slice.

Transport returns `serde_json::Value`. Deserialize into your typed structs with
`serde_json::from_value(v)?`.

## Conventions

1. **Module layout** mirrors Python. For domain `foo`, create:
   - `src/foo/mod.rs` — `pub mod types; pub mod resources;` + re-exports, plus
     any domain exceptions (`pub mod exceptions;` if Python has `foo/exceptions.py`).
   - `src/foo/types.rs` — all structs/enums.
   - `src/foo/resources/mod.rs` — `pub mod <each>;`
   - `src/foo/resources/<name>.rs` — one per Python resource file.
   Use snake_case file names matching Python (`contact_rules.rs`, etc.).

2. **Structs**: `#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]`.
   - Field names already snake_case → no rename needed.
   - Optional/absent fields → `Option<T>` with
     `#[serde(default, skip_serializing_if = "Option::is_none")]`.
   - UUIDs → `uuid::Uuid`. Timestamps that arrive as epoch floats → `f64`.
     Timestamps as ISO strings → `String` (do not invent chrono).
   - Money/unknown numerics → keep the Python type (`i64`/`f64`).

3. **Enums** (Python `str, Enum`): map to a Rust enum with
   `#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]`
   and `#[serde(rename_all = "snake_case")]`, OR per-variant
   `#[serde(rename = "...")]` to match each Python `.value` EXACTLY. Verify every
   value against the Python source.

4. **Resources**: a struct holding `http: Arc<HttpTransport>` with a
   `pub fn new(http: Arc<HttpTransport>) -> Self`. Methods take `&self`, return
   `Result<T>`. Reproduce the exact path, query params, and JSON body of the
   Python method. Keep method names in snake_case matching Python.

5. **Request bodies**: prefer `serde_json::json!({...})` built inline to match
   the Python dict exactly, including conditional insertion of optional keys
   (Python omits `None` keys — replicate with a `serde_json::Map` you insert
   into conditionally, or `json!` + remove). Match Python's "omit when None".

6. **Sentinels**: where Python uses an `_UNSET` sentinel to distinguish
   "omit" from "explicit null", model the argument as `Option<Option<T>>`
   (outer `None` = omit, `Some(None)` = explicit JSON null, `Some(Some(x))` =
   value) OR a small `Unset<T>` enum. Pick whichever reads cleanly and
   document it. Match the wire behaviour precisely.

7. **Docstrings**: port the Python docstrings as `///` doc comments. Include
   `# Arguments` / `# Returns` where the Python had `Args:` / `Returns:`. Keep
   inline comments explaining non-obvious steps. Match the surrounding density —
   don't bloat.

8. **No new crates** beyond what `Cargo.toml` already lists. Compile-clean Rust
   2021. Do not add `async`. Do not run `cargo build` (the workspace isn't wired
   up yet — the orchestrator compiles at the end).

9. Return your final message as a short summary: files created, any wire
   ambiguity you resolved, and anything you stubbed or were unsure about.
