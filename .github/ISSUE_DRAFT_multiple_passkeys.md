## Summary

Using the primary (red) passkey button while the UI shows **"Authenticate with existing Passkey"**, Chrome's passkey manager ends up with **multiple passkeys** for this origin instead of reusing one. That suggests **`navigator.credentials.create()` is being invoked when the user expects reuse** of an existing credential.

## Expected vs actual

**Expected:** If local hints indicate an existing passkey (`hasLocalPasskeyHint()` → that label), the flow should not register a new discoverable credential on each visit unless storage was cleared.

**Actual:** Multiple discoverable passkeys accumulate for the same RP even when using the primary button with "existing" copy.

## Code observations

1. **`initialize()` runs before OrbitDB registry is attached** — `handleAuthenticate()` calls `identityService.initialize()` before `initRegistryDb()`. `#tryRestoreWorkerIdentity()` only reads the registry if `#registryDb` is set; on a fresh load it often is not, so restore falls back to localStorage paths.

2. **Worker restore metadata** — `loadWebAuthnCredentialSafe()` is used for restore, but this repo does not call `storeWebAuthnCredentialSafe()` under `src/`. The `p2p_passkeys_worker_archive` key is read in `identity-service.js` but not written in this repo.

3. **Fallback** — If hardware `load()` fails and worker restore returns false, `initialize()` falls through to `#createWorkerIdentity()` → `#createWebAuthnCredential()` → **`credentials.create()`** again.

4. **Hardware path** — `WebAuthnHardwareSignerService.initialize()` does `load()` first; less likely to multiply passkeys if varsig storage persists.

## Hypothesis

Strongest in **Worker Ed25519**: missing persistence for next-session restore + registry unavailable during first `initialize()`, so UI can say "existing" while code still hits `create()`.

Open question for **`@le-space/orbitdb-identity-provider-webauthn-did`**: should credential metadata be persisted automatically after create, or must the app call `storeWebAuthnCredentialSafe()` after `#createWebAuthnCredential()`?

## Suggested direction

1. After successful worker registration, persist what `loadWebAuthnCredentialSafe()` needs, and/or persist the worker archive cache consistently.
2. Consider restructuring so worker restore can use OrbitDB/registry when localStorage webauthn metadata is missing but the encrypted archive exists.
3. Tighten UI copy if "Authenticate with existing" cannot be guaranteed from hints alone.

## Reproduction (draft)

1. Create identity with Worker Ed25519 via primary button.
2. Close tab; reopen same origin.
3. Use primary button again with "Authenticate with existing Passkey" if shown.
4. Chrome passkey manager: expect 1 credential, observe N after cycles.
