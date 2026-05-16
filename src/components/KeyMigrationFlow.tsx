// FOR SECURITY RESEARCH ONLY — NOT FOR PRODUCTION USE
//
// End-to-end key migration: Fireblocks NCW (Full Key Takeover, client-side via
// the NCW JS SDK) -> Dynamic WaaS (importPrivateKey, splits into MPC shares).
//
// Private key material lives only in this component's React state and is wiped
// after a successful Dynamic import. The backend sees the migration intent and
// the final addresses, never the key itself.
import React from "react";
import {
  ChainEnum,
  useDynamicContext,
  useDynamicWaas,
  useIsLoggedIn,
  useUserWallets,
} from "@dynamic-labs/sdk-react-core";
import type { IFullKey } from "@fireblocks/ncw-js-sdk";
import { Card, ICardAction } from "./ui/Card";
import { useAppStore } from "../AppStore";

const SEPOLIA_ASSET_ID = "ETH_TEST5";
const ACCOUNT_ID = 0;
const SEPOLIA_COIN_TYPE = 1; // BIP44 testnet
const VERIFY_MESSAGE = "Fireblocks → Dynamic key migration verification";

const shortAddr = (addr: string | undefined | null) =>
  addr ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : "—";

const shortKey = (k: string | null) =>
  k ? `${k.slice(0, 6)}…${k.slice(-4)} (${k.length} chars)` : "—";

export const KeyMigrationFlow: React.FC = () => {
  const { primaryWallet, setShowAuthFlow, handleLogOut } = useDynamicContext();
  const { importPrivateKey } = useDynamicWaas();
  const userWallets = useUserWallets();
  const isLoggedIn = useIsLoggedIn();
  const {
    walletId,
    accounts,
    takeover,
    deriveAssetKey,
    startKeyMigration,
    completeKeyMigration,
  } = useAppStore();

  const [migrationId, setMigrationId] = React.useState<string | null>(null);
  const [exportedKey, setExportedKey] = React.useState<string | null>(null);
  const [exportedEcdsaKey, setExportedEcdsaKey] = React.useState<IFullKey | null>(null);
  const [exporting, setExporting] = React.useState(false);
  const [importing, setImporting] = React.useState(false);
  const [verifying, setVerifying] = React.useState(false);
  const [verificationSig, setVerificationSig] = React.useState<string | null>(null);
  const [serverAck, setServerAck] = React.useState<{
    addressesMatch: boolean;
  } | null>(null);
  const [importedAddress, setImportedAddress] = React.useState<string | null>(null);
  const [pendingMatch, setPendingMatch] = React.useState<{
    migrationId: string;
    fireblocksAddress: string;
  } | null>(null);
  const [awaitingAuth, setAwaitingAuth] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const fireblocksAddress =
    (accounts[ACCOUNT_ID]?.[SEPOLIA_ASSET_ID]?.address as { address?: string } | undefined)
      ?.address ?? null;
  // Only ever surface the imported wallet here. `primaryWallet` may point at a
  // wallet created by the sibling sweep flow (different address), which would
  // make the destination row misleading. Show nothing until import lands.
  const dynamicAddress = importedAddress;
  const addressesMatch =
    !!fireblocksAddress &&
    !!dynamicAddress &&
    fireblocksAddress.toLowerCase() === dynamicAddress.toLowerCase();

  const handleExport = async () => {
    setError(null);
    setVerificationSig(null);
    setServerAck(null);
    if (!walletId) {
      setError("No NCW walletId available");
      return;
    }
    if (!fireblocksAddress) {
      setError(
        `Fetch ${SEPOLIA_ASSET_ID} balance/address in the Assets card first (so we know the source address).`,
      );
      return;
    }
    setExporting(true);
    try {
      const intent = await startKeyMigration(walletId, SEPOLIA_ASSET_ID);
      setMigrationId(intent.migrationId);

      const fullKeys = await takeover();
      const ecdsa = fullKeys.find((k) => k.algorithm === "MPC_CMP_ECDSA_SECP256K1");
      if (!ecdsa) {
        throw new Error("No ECDSA secp256k1 key returned by takeover()");
      }
      // Derive the per-asset (Sepolia) private key from the extended xprv.
      const assetKey = deriveAssetKey(
        ecdsa.privateKey,
        SEPOLIA_COIN_TYPE,
        ACCOUNT_ID,
        0,
        0,
      );
      setExportedEcdsaKey(ecdsa);
      setExportedKey(assetKey);
    } catch (e) {
      console.log("[KeyMigrationFlow] export failed", e);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setExporting(false);
    }
  };

  const runImport = React.useCallback(async () => {
    if (!exportedKey || !migrationId || !fireblocksAddress) return;
    setImporting(true);
    try {
      const pk = exportedKey.startsWith("0x") ? exportedKey.slice(2) : exportedKey;
      await importPrivateKey({
        chainName: ChainEnum.Evm,
        privateKey: pk,
        addressType: "Ethereum",
      });
      // Defer the wallet-match + server ack to a useEffect that watches the
      // reactive `userWallets` array — the SDK updates it via context after
      // the import settles, so we react instead of polling.
      setPendingMatch({ migrationId, fireblocksAddress });
      // Zeroize key material in component state — import has consumed it.
      setExportedKey(null);
      setExportedEcdsaKey(null);
    } catch (e) {
      console.log("[KeyMigrationFlow] import failed", e);
      const msg = e instanceof Error ? e.message : String(e);
      // Dynamic returns `WalletApiError: Authorization header or cookie is
      // required` when the WaaS session has gone stale even though
      // `isLoggedIn` still reads true (cookie expired, cross-origin storage
      // cleared, etc). Force a fresh sign-in and re-queue the import.
      if (/authoriz|unauthorized|cookie/i.test(msg)) {
        setImporting(false);
        try {
          await handleLogOut();
        } catch {
          /* ignore */
        }
        setAwaitingAuth(true);
        setShowAuthFlow(true);
        return;
      }
      setError(msg);
      setImporting(false);
    }
  }, [
    exportedKey,
    migrationId,
    fireblocksAddress,
    importPrivateKey,
    handleLogOut,
    setShowAuthFlow,
  ]);

  const handleImport = async () => {
    setError(null);
    if (!exportedKey) {
      setError("No exported key in memory — run Export first.");
      return;
    }
    if (!migrationId) {
      setError("Missing migrationId — re-run Export.");
      return;
    }
    if (!fireblocksAddress) {
      setError("Fireblocks source address missing — fetch ETH_TEST5 address first.");
      return;
    }
    if (!isLoggedIn) {
      // Pop OTP modal; useEffect below auto-resumes the import on auth success.
      setAwaitingAuth(true);
      setShowAuthFlow(true);
      return;
    }
    await runImport();
  };

  // When the OTP modal flips us to authenticated, resume the import that was
  // queued by handleImport.
  React.useEffect(() => {
    if (!awaitingAuth || !isLoggedIn) return;
    setAwaitingAuth(false);
    runImport();
  }, [awaitingAuth, isLoggedIn, runImport]);

  // Reactive wallet-match: when the imported wallet appears in `userWallets`,
  // record the address and call the backend completion endpoint exactly once.
  React.useEffect(() => {
    if (!pendingMatch) return;
    const target = pendingMatch.fireblocksAddress.toLowerCase();
    const matched = userWallets.find(
      (w) => typeof w.address === "string" && w.address.toLowerCase() === target,
    );
    if (!matched?.address) return;
    const newDynamicAddress = matched.address;
    setImportedAddress(newDynamicAddress);
    const { migrationId: mid, fireblocksAddress: fba } = pendingMatch;
    setPendingMatch(null);
    completeKeyMigration(mid, fba, newDynamicAddress)
      .then((ack) => setServerAck({ addressesMatch: ack.addressesMatch }))
      .catch((e) => {
        console.log("[KeyMigrationFlow] completeKeyMigration failed", e);
        setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => setImporting(false));
  }, [pendingMatch, userWallets, completeKeyMigration]);

  // Timeout fallback so we don't sit on `importing` forever if the wallet
  // never propagates (10s grace period).
  React.useEffect(() => {
    if (!pendingMatch) return;
    const t = setTimeout(() => {
      setPendingMatch((cur) => {
        if (cur) {
          setError(
            "Import succeeded but no Dynamic wallet appeared in 10s — refresh the page; the wallet may already be in your Dynamic dashboard.",
          );
          setImporting(false);
        }
        return null;
      });
    }, 10_000);
    return () => clearTimeout(t);
  }, [pendingMatch]);

  const handleVerify = async () => {
    setError(null);
    if (!importedAddress) {
      setError("Import the key first.");
      return;
    }
    const target = importedAddress.toLowerCase();
    const wallet = userWallets.find(
      (w) => typeof w.address === "string" && w.address.toLowerCase() === target,
    );
    if (!wallet) {
      setError("Imported wallet not found in Dynamic WaaS wallet list.");
      return;
    }
    if (typeof wallet.signMessage !== "function") {
      setError("Imported wallet doesn't support signMessage");
      return;
    }
    setVerifying(true);
    try {
      const sig = await wallet.signMessage(VERIFY_MESSAGE);
      if (!sig) throw new Error("No signature returned");
      setVerificationSig(sig);
    } catch (e) {
      console.log("[KeyMigrationFlow] verify failed", e);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setVerifying(false);
    }
  };

  React.useEffect(() => {
    return () => {
      // Best-effort wipe on unmount.
      setExportedKey(null);
      setExportedEcdsaKey(null);
    };
  }, []);

  const importLabel = !isLoggedIn
    ? "Sign in & Import Key to Dynamic"
    : "Import Key to Dynamic";
  const actions: ICardAction[] = [
    {
      label: exportedKey ? "Re-export Key" : "Export Key from Fireblocks",
      action: handleExport,
      isInProgress: exporting,
      isDisabled: exporting || importing || awaitingAuth,
    },
    {
      label: importLabel,
      action: handleImport,
      isInProgress: importing || awaitingAuth,
      isDisabled: !exportedKey || importing || exporting || awaitingAuth,
      buttonVariant: "accent",
    },
    {
      label: verificationSig ? "Re-sign Verification" : "Verify by Signing",
      action: handleVerify,
      isInProgress: verifying,
      isDisabled: !dynamicAddress || !serverAck || verifying,
    },
  ];

  return (
    <Card title="Key Migration (Fireblocks → Dynamic)" actions={actions}>
      <div className="text-sm space-y-3">
        <p className="text-xs opacity-60">
          Exports the secp256k1 private key for {SEPOLIA_ASSET_ID} via Fireblocks Full Key
          Takeover (client-side), then imports it into Dynamic WaaS so the resulting wallet
          shares the same address. No on-chain transfer.
        </p>

        <div className="space-y-1">
          <div className="flex items-baseline gap-2 flex-wrap">
            <span className="text-xs uppercase tracking-widest opacity-50">Fireblocks NCW</span>
            {fireblocksAddress && <span className="text-xs text-success">✓ source</span>}
          </div>
          <p className="font-mono text-xs">
            {fireblocksAddress ?? "— fetch balance/address first —"}
          </p>
        </div>

        <div className="space-y-1">
          <div className="flex items-baseline gap-2 flex-wrap">
            <span className="text-xs uppercase tracking-widest opacity-50">Exported key</span>
            {exportedKey && <span className="text-xs text-warning">in-memory only</span>}
            {!exportedKey && serverAck && (
              <span className="text-xs text-success">✓ wiped after import</span>
            )}
          </div>
          <p className="font-mono text-xs opacity-70">
            {exportedEcdsaKey
              ? `keyId ${exportedEcdsaKey.keyId.slice(0, 8)}… · `
              : ""}
            {shortKey(exportedKey)}
          </p>
        </div>

        <div className="space-y-1">
          <div className="flex items-baseline gap-2 flex-wrap">
            <span className="text-xs uppercase tracking-widest opacity-50">
              Dynamic WaaS (imported)
            </span>
            {dynamicAddress && <span className="text-xs text-success">✓ destination</span>}
          </div>
          <p className="font-mono text-xs">
            {dynamicAddress ??
              (awaitingAuth
                ? "— complete Dynamic sign-in to continue —"
                : "— click Import Key (sign-in is triggered automatically) —")}
          </p>
          {!dynamicAddress && primaryWallet?.address && (
            <p className="text-[10px] opacity-50 italic">
              Note: {shortAddr(primaryWallet.address)} is from the sibling
              sweep-flow card and is unrelated to this import.
            </p>
          )}
        </div>

        {serverAck && (
          <p
            className={`text-xs ${
              serverAck.addressesMatch ? "text-success" : "text-error"
            }`}
          >
            {serverAck.addressesMatch
              ? "✓ Server confirmed addresses match — same wallet, new MPC backing."
              : "✗ Server reports address mismatch — review derivation path."}
          </p>
        )}

        {!serverAck && fireblocksAddress && dynamicAddress && (
          <p className="text-xs opacity-60">
            Client comparison:{" "}
            <span className={addressesMatch ? "text-success" : "text-error"}>
              {addressesMatch ? "match" : "no match"}
            </span>
          </p>
        )}

        {verificationSig && (
          <div className="space-y-1">
            <span className="text-xs uppercase tracking-widest opacity-50 text-success">
              ✓ Signed via Dynamic
            </span>
            <p className="font-mono text-xs opacity-70">
              {verificationSig.slice(0, 18)}…{verificationSig.slice(-10)}
            </p>
          </div>
        )}

        {error && <p className="text-error text-xs">Error: {error}</p>}
      </div>
    </Card>
  );
};
