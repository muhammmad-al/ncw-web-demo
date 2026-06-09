// Proof of concept — demonstrates the migration model; not production-hardened.
//
// End-to-end key migration: Fireblocks NCW (Full Key Takeover, client-side via
// the NCW JS SDK) -> Dynamic WaaS (importPrivateKey, re-splits into MPC shares).
//
// Private key material lives only in this component's React state and is wiped
// after a successful Dynamic import. The backend only ever sees the migration
// intent and the resulting addresses, never the key itself.
import React from "react";
import {
  ChainEnum,
  useDynamicContext,
  useDynamicWaas,
  useIsLoggedIn,
  useUserWallets,
} from "@dynamic-labs/sdk-react-core";
import { Card, ICardAction } from "./ui/Card";
import { useAppStore } from "../AppStore";

const SEPOLIA_ASSET_ID = "ETH_TEST5";
const ACCOUNT_ID = 0;
const SEPOLIA_COIN_TYPE = 1; // BIP44 testnet
const VERIFY_MESSAGE = "Fireblocks → Dynamic key migration verification";

export const KeyMigrationFlow: React.FC = () => {
  const { setShowAuthFlow, handleLogOut } = useDynamicContext();
  const { importPrivateKey, getWaasWallets } = useDynamicWaas();
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
  const [matchTick, setMatchTick] = React.useState(0);
  const [awaitingAuth, setAwaitingAuth] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const fireblocksAddress =
    (accounts[ACCOUNT_ID]?.[SEPOLIA_ASSET_ID]?.address as { address?: string } | undefined)
      ?.address ?? null;
  const dynamicAddress = importedAddress;

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
      setExportedKey(assetKey);
    } catch (e) {
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
      // Import has consumed the key — wipe it from component state.
      setExportedKey(null);
      // Hand off to the matcher effect below. It watches the reactive
      // `useUserWallets()` list — an imported key surfaces there (usually
      // within seconds once Dynamic refreshes the session) — and also re-polls
      // `getWaasWallets()` on a ticker as a fallback, completing the migration
      // once the imported wallet appears.
      setPendingMatch({ migrationId, fireblocksAddress });
    } catch (e) {
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

  // Matcher: once an import is pending, look for the imported wallet across
  // both the reactive `useUserWallets()` list (fast path — re-runs this effect
  // whenever it updates) and `getWaasWallets()` (fallback, re-checked by the
  // ticker below). When it appears, record the address and call the backend
  // completion endpoint exactly once.
  React.useEffect(() => {
    if (!pendingMatch) return;
    const target = pendingMatch.fireblocksAddress.toLowerCase();
    const matched = [...getWaasWallets(), ...userWallets].find(
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
        setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => setImporting(false));
  }, [pendingMatch, userWallets, matchTick, getWaasWallets, completeKeyMigration]);

  // Ticker: re-run the matcher every 1.5s while a match is pending, so the
  // `getWaasWallets()` fallback gets re-polled even if `userWallets` doesn't
  // change reference.
  React.useEffect(() => {
    if (!pendingMatch) return;
    const iv = setInterval(() => setMatchTick((t) => t + 1), 1500);
    return () => clearInterval(iv);
  }, [pendingMatch]);

  // Timeout fallback so we don't sit on `importing` forever if the wallet
  // never propagates (60s grace period).
  React.useEffect(() => {
    if (!pendingMatch) return;
    const t = setTimeout(() => {
      setPendingMatch((cur) => {
        if (cur) {
          setError(
            "Imported, but the new Dynamic wallet didn't appear within 60s — refresh the page; " +
              "it may already be in your Dynamic dashboard, then use Verify Ownership.",
          );
          setImporting(false);
        }
        return null;
      });
    }, 60_000);
    return () => clearTimeout(t);
  }, [pendingMatch]);

  const handleVerify = async () => {
    setError(null);
    if (!importedAddress) {
      setError("Import the key first.");
      return;
    }
    const target = importedAddress.toLowerCase();
    const wallet =
      getWaasWallets().find(
        (w) => typeof w.address === "string" && w.address.toLowerCase() === target,
      ) ??
      userWallets.find(
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
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setVerifying(false);
    }
  };

  React.useEffect(() => {
    return () => {
      // Best-effort wipe on unmount.
      setExportedKey(null);
    };
  }, []);

  const importLabel = !isLoggedIn ? "Sign in & Import to Dynamic" : "Import to Dynamic";
  const actions: ICardAction[] = [
    {
      label: exportedKey ? "Re-export Key" : "Export Key",
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
      label: verificationSig ? "Re-verify" : "Verify Ownership",
      action: handleVerify,
      isInProgress: verifying,
      isDisabled: !dynamicAddress || !serverAck || verifying,
    },
  ];

  // Single-line status indicator.
  const status = verificationSig
    ? "Verified ✓"
    : serverAck
      ? serverAck.addressesMatch
        ? "Imported ✓"
        : "Address mismatch"
      : importedAddress
        ? "Imported ✓"
        : importing || awaitingAuth
          ? "Importing…"
          : exportedKey
            ? "Exported ✓"
            : exporting
              ? "Exporting…"
              : "Ready";
  const statusClass =
    status === "Address mismatch"
      ? "text-error"
      : status.endsWith("✓")
        ? "text-success"
        : "opacity-70";

  return (
    <Card title="Key Migration: Fireblocks → Dynamic" actions={actions}>
      <div className="text-sm space-y-2">
        <div className="flex items-baseline justify-between gap-2 flex-wrap">
          <span className="text-xs uppercase tracking-widest opacity-50">
            Source (Fireblocks)
          </span>
          <span className="font-mono text-xs">{fireblocksAddress ?? "Not available"}</span>
        </div>
        <div className="flex items-baseline justify-between gap-2 flex-wrap">
          <span className="text-xs uppercase tracking-widest opacity-50">Target (Dynamic)</span>
          <span className="font-mono text-xs">{dynamicAddress ?? "Not yet imported"}</span>
        </div>
        <div className="flex items-baseline justify-between gap-2 flex-wrap">
          <span className="text-xs uppercase tracking-widest opacity-50">Status</span>
          <span className={`text-xs ${statusClass}`}>{status}</span>
        </div>
        {error && <p className="text-error text-xs">Error: {error}</p>}
      </div>
    </Card>
  );
};
