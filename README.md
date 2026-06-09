# Fireblocks NCW → Dynamic WaaS — Migration POC (frontend)

A proof-of-concept web app demonstrating **migration of wallets from Fireblocks
Embedded Wallets (NCW) to [Dynamic](https://www.dynamic.xyz/) WaaS**. It is a fork
of Fireblocks' official [NCW web demo](https://github.com/fireblocks/ncw-web-demo)
with two migration flows added on top of the reference wallet functionality.

> ⚠️ **Proof of concept — not production-hardened.** It demonstrates the
> client-side key-handling model and the audit hand-off to the backend. See the
> [Migration Guide](./MIGRATION_GUIDE.md) and the Security section below before
> adapting any of this for production.

## What's in it

Two migration strategies, rendered side by side as cards in the demo:

| Flow | Component | What it does | Asset transfer? |
|------|-----------|--------------|-----------------|
| **Asset sweep** | `MigrationFlow.tsx` | Provisions a Dynamic embedded wallet, then sends funds from the NCW wallet to it on-chain. Keeps the MPC security model; addresses change. | Yes (on-chain) |
| **Key migration** | `KeyMigrationFlow.tsx` | Exports the private key client-side via Fireblocks **Full Key Takeover**, imports it into Dynamic via `importPrivateKey`. Resulting wallet keeps the **same address**. | No |

## Prerequisites

- **Node 20** (`.nvmrc` is checked in — run `nvm use`)
- A **Fireblocks workspace** with NCW enabled and **Full Key Takeover** enabled
- A **Dynamic environment** with **WaaS** configured (Embedded Wallets). Disable
  `automaticEmbeddedWalletCreation` so `importPrivateKey` creates the wallet (see
  the [Migration Guide](./MIGRATION_GUIDE.md))
- A **Firebase project** for end-user auth (Google/Apple sign-in) — the Firebase
  client config is bundled in `src/auth/FirebaseAuthManager.ts`
- The companion backend running: [`ncw-backend-demo`](../ncw-backend-demo) on
  `http://localhost:3000`

## Environment variables

Copy `.env.example` to `.env` and fill in. All vars are `VITE_`-prefixed and ship
to the browser bundle — **do not put secrets here**.

| Variable | Purpose |
|----------|---------|
| `VITE_AUTOMATE_INITIALIZATION` | Auto-init the NCW SDK on load (`true`/`false`) |
| `VITE_BACKEND_BASE_URL` | Backend API base URL (e.g. `http://localhost:3000`) |
| `VITE_NCW_SDK_ENV` | `sandbox` or `production` — must match the backend's workspace |
| `VITE_DYNAMIC_ENVIRONMENT_ID` | Dynamic environment ID (Dashboard → Developers → SDK) |
| `VITE_CLOUDKIT_APITOKEN` | Apple CloudKit token (optional — iCloud key backup) |
| `VITE_CLOUDKIT_CONTAINER_ID` | CloudKit container (optional) |
| `VITE_CLOUDKIT_ENV` | CloudKit environment (optional) |

## Run

```bash
nvm use          # Node 20 from .nvmrc
npm install
npm run dev      # Vite dev server on http://localhost:5173
```

Other scripts: `npm run build` (type-check + production build), `npm run preview`
(serve the build), `npm run lint`.

## Architecture

- **Client-side key handling.** During key migration the private key is
  reconstructed in the browser (NCW SDK MPC) and handed straight to Dynamic's
  `importPrivateKey`. **It is never sent to the backend.**
- **Backend is an audit trail only.** The frontend calls
  `POST /api/migration/start` and `POST /api/migration/complete` to record intent
  and outcome (wallet/asset IDs, source/destination addresses, match result). The
  backend rejects any request that contains key material.
- **State:** [Zustand](https://github.com/pmndrs/zustand) (`AppStore.ts`), a single
  store holding auth, NCW, account, and transaction state.
- **Auth:** Firebase ID token (JWT) attached as `Authorization: Bearer …` on every
  backend call and on the Socket.IO handshake.
- **NCW RPC relay:** MPC messages are piped over Socket.IO through the backend to
  Fireblocks (`ApiService.sendMessage` → backend `invokeWalletRpc`).
- **Dynamic:** `DynamicContextProvider` wraps the app (`src/dynamic/config.ts`);
  flows use `useDynamicWaas` (`importPrivateKey`, `createWalletAccount`) and
  `useUserWallets`.

## Key files

| File | Role |
|------|------|
| `src/components/KeyMigrationFlow.tsx` | Key migration (Full Key Takeover → `importPrivateKey`) |
| `src/components/MigrationFlow.tsx` | Asset-sweep migration |
| `src/components/FireblocksNCWExampleActions.tsx` | Renders the action cards (migration up front; raw takeover / Web3 / logs collapsed) |
| `src/AppStore.ts` | Zustand store; NCW SDK init, `takeover`, `deriveAssetKey`, migration calls |
| `src/services/ApiService.ts` | Backend REST + Socket.IO client |
| `src/dynamic/config.ts` | Dynamic SDK configuration |
| `src/auth/FirebaseAuthManager.ts` | Firebase auth / JWT |

## Security

- The private key exists in browser memory only during the migration window and is
  wiped from component state after a successful import. Iframe isolation (in
  progress with the Dynamic team) is intended to harden this against malicious JS.
- The backend never receives key material and actively rejects `privateKey`/`key`
  fields on the audit endpoints.

See [`MIGRATION_GUIDE.md`](./MIGRATION_GUIDE.md) for the full customer-facing
walkthrough, code snippets, and scope/limitations.

## Tech

- [Fireblocks NCW SDK](https://www.npmjs.com/package/@fireblocks/ncw-js-sdk)
- [Dynamic SDK](https://www.npmjs.com/package/@dynamic-labs/sdk-react-core)
- [TypeScript](https://www.npmjs.com/package/typescript) · [Vite](https://vitejs.dev) · [React](https://react.dev) · [Zustand](https://github.com/pmndrs/zustand)
