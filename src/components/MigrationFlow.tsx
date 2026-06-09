import React from "react";
import {
  useDynamicContext,
  useDynamicWaas,
  useIsLoggedIn,
  ChainEnum,
} from "@dynamic-labs/sdk-react-core";
import { Card, ICardAction } from "./ui/Card";
import { useAppStore } from "../AppStore";

const SEPOLIA_ASSET_ID = "ETH_TEST5";
const ACCOUNT_ID = 0;
const SWEEP_AMOUNT_ETH = 0.01;
const OWNERSHIP_MESSAGE =
  "I own this Dynamic wallet and authorize the migration from Fireblocks";
const SEPOLIA_EXPLORER = "https://sepolia.etherscan.io";

const SectionLabel: React.FC<{ children: React.ReactNode; done?: boolean }> = ({
  children,
  done,
}) => (
  <p
    className={`text-[10px] uppercase tracking-widest font-semibold pt-2 ${
      done ? "text-success" : "opacity-50"
    }`}
  >
    {done ? "✓ " : ""}
    {children}
  </p>
);

const CopyButton: React.FC<{ value: string }> = ({ value }) => {
  const [copied, setCopied] = React.useState(false);
  return (
    <button
      type="button"
      className="btn btn-xs btn-ghost ml-1 px-2 h-6 min-h-0 normal-case font-normal"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        } catch {
          /* ignore */
        }
      }}
      title="Copy to clipboard"
    >
      {copied ? "✓" : "📋"}
    </button>
  );
};

const shortAddr = (addr: string | undefined | null) =>
  addr ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : "—";

export const MigrationFlow: React.FC = () => {
  const { setShowAuthFlow, primaryWallet, user, handleLogOut } = useDynamicContext();
  const { createWalletAccount } = useDynamicWaas();
  const isLoggedIn = useIsLoggedIn();
  const { accounts, addAsset, refreshBalance, createTransaction, signTransaction, txs } =
    useAppStore();

  const [creatingWallet, setCreatingWallet] = React.useState(false);
  const [fetchingBalance, setFetchingBalance] = React.useState(false);
  const [sweeping, setSweeping] = React.useState(false);
  const [sweepTxId, setSweepTxId] = React.useState<string | null>(null);
  const [progress, setProgress] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [signingOwnership, setSigningOwnership] = React.useState(false);
  const [ownershipSignature, setOwnershipSignature] = React.useState<string | null>(null);

  const hasWallet = !!primaryWallet?.address;
  const isAuthed = isLoggedIn || hasWallet;
  const ethBalanceRaw = accounts[ACCOUNT_ID]?.[SEPOLIA_ASSET_ID]?.balance;
  const ethBalance = ethBalanceRaw?.available ?? ethBalanceRaw?.total ?? null;
  const balanceFetched = ethBalance !== null;

  const FAILURE_STATES = [
    "FAILED",
    "CANCELLED",
    "REJECTED",
    "BLOCKED",
    "INSUFFICIENT_FUNDS",
    "FAILED_AML_SCREENING",
    "TIMEOUT",
  ];
  const sweepTx = sweepTxId ? txs.find((t) => t.id === sweepTxId) : null;
  const sweepStatus = sweepTx?.status;
  const isSweepTerminal =
    sweepStatus === "COMPLETED" || (sweepStatus ? FAILURE_STATES.includes(sweepStatus) : false);

  const signTriggeredRef = React.useRef<string | null>(null);

  React.useEffect(() => {
    if (!sweepTxId || !sweepStatus) return;
    if (sweepStatus === "COMPLETED") {
      setProgress("Migration complete!");
      setSweeping(false);
    } else if (FAILURE_STATES.includes(sweepStatus)) {
      setError(`Sweep ${sweepStatus.toLowerCase().replace(/_/g, " ")}`);
      setSweeping(false);
    } else {
      setProgress(`Sweep status: ${sweepStatus}`);
      if (sweepStatus === "PENDING_SIGNATURE" && signTriggeredRef.current !== sweepTxId) {
        signTriggeredRef.current = sweepTxId;
        signTransaction(sweepTxId).catch((e) => {
          setError(e instanceof Error ? e.message : String(e));
        });
      }
    }
  }, [sweepTxId, sweepStatus, signTransaction]);

  const handleMigrate = () => {
    setError(null);
    setShowAuthFlow(true);
  };

  const handleCreateWallet = async () => {
    setError(null);
    setCreatingWallet(true);
    try {
      await createWalletAccount([ChainEnum.Evm]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCreatingWallet(false);
    }
  };

  const handleFetchBalance = async () => {
    setError(null);
    setFetchingBalance(true);
    try {
      const existingAsset = accounts[ACCOUNT_ID]?.[SEPOLIA_ASSET_ID]?.asset;
      if (!existingAsset) {
        try {
          await addAsset(ACCOUNT_ID, SEPOLIA_ASSET_ID);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          setError(
            `Could not enable ${SEPOLIA_ASSET_ID} in this NCW wallet (${msg}). ` +
              `Pick an asset that's already in the Assets card and update SEPOLIA_ASSET_ID in MigrationFlow.tsx.`,
          );
          return;
        }
      }
      await refreshBalance(ACCOUNT_ID, SEPOLIA_ASSET_ID);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setFetchingBalance(false);
    }
  };

  const handleProveOwnership = async () => {
    setError(null);
    if (!primaryWallet) {
      setError("Dynamic wallet not available");
      return;
    }
    if (typeof primaryWallet.signMessage !== "function") {
      setError("This Dynamic wallet doesn't support signMessage");
      return;
    }
    setSigningOwnership(true);
    try {
      const signature = await primaryWallet.signMessage(OWNERSHIP_MESSAGE);
      if (!signature) {
        throw new Error("No signature returned");
      }
      setOwnershipSignature(signature);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSigningOwnership(false);
    }
  };

  const handleSweep = async () => {
    setError(null);
    setProgress(null);
    if (!primaryWallet?.address) {
      setError("Dynamic wallet address not available");
      return;
    }
    if (ethBalance === null) {
      setError("Fetch balance first");
      return;
    }
    const total = parseFloat(ethBalance);
    if (!Number.isFinite(total) || total < SWEEP_AMOUNT_ETH) {
      setError(`Balance ${ethBalance} ETH is too low to sweep ${SWEEP_AMOUNT_ETH} ETH`);
      return;
    }
    const amount = SWEEP_AMOUNT_ETH.toFixed(8);
    setSweeping(true);
    setProgress(`Sending ${amount} ETH to ${primaryWallet.address}…`);
    try {
      const tx = await createTransaction({
        note: "NCW → Dynamic migration sweep",
        accountId: String(ACCOUNT_ID),
        assetId: SEPOLIA_ASSET_ID,
        amount,
        destAddress: primaryWallet.address,
        feeLevel: "LOW",
      });
      setSweepTxId(tx.id);
      setProgress(`Transaction submitted (${tx.id.slice(0, 8)}…). Waiting for signature…`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSweeping(false);
    }
  };

  const actions: ICardAction[] = [];

  if (!isAuthed) {
    actions.push({
      label: "Migrate to Dynamic",
      action: handleMigrate,
      buttonVariant: "accent",
    });
  } else if (!hasWallet) {
    actions.push({
      label: "Create Dynamic Wallet",
      action: handleCreateWallet,
      isInProgress: creatingWallet,
      isDisabled: creatingWallet,
    });
  } else {
    actions.push({
      label: balanceFetched ? "Refresh Balance" : "Fetch Balance",
      action: handleFetchBalance,
      isInProgress: fetchingBalance,
      isDisabled: fetchingBalance || sweeping,
    });
    actions.push({
      label: ownershipSignature ? "Re-sign Ownership" : "Prove Ownership",
      action: handleProveOwnership,
      isInProgress: signingOwnership,
      isDisabled: signingOwnership || sweeping,
    });
    actions.push({
      label: "Sweep Assets",
      action: handleSweep,
      isInProgress: sweeping && !isSweepTerminal,
      isDisabled: sweeping || !balanceFetched,
      buttonVariant: "accent",
    });
    actions.push({
      label: "Log out of Dynamic",
      action: handleLogOut,
      isDisabled: sweeping && !isSweepTerminal,
    });
  }

  const sweepTxHash = (sweepTx as { txHash?: string } | null)?.txHash || null;
  const ncwSourceAddress =
    (accounts[ACCOUNT_ID]?.[SEPOLIA_ASSET_ID]?.address as { address?: string } | undefined)
      ?.address ?? null;

  return (
    <Card title="Migrate to Dynamic" actions={actions}>
      <div className="text-sm space-y-3">
        {/* ─── Destination wallet (the migration target) ─── */}
        {!isAuthed ? (
          <p className="opacity-70">
            Authenticate with Dynamic via email OTP to provision a destination embedded wallet.
          </p>
        ) : (
          <div className="space-y-1">
            <div className="flex items-baseline gap-2 flex-wrap">
              <span className="text-xs uppercase tracking-widest opacity-50">Destination</span>
              {hasWallet && <span className="text-xs text-success">✓ Dynamic embedded</span>}
            </div>
            <p className="opacity-80">{user?.email ?? user?.userId ?? "unknown"}</p>
            {hasWallet && primaryWallet?.address && (
              <p className="flex items-center flex-wrap font-mono text-sm">
                {primaryWallet.address}
                <CopyButton value={primaryWallet.address} />
              </p>
            )}
          </div>
        )}

        {/* ─── Ownership signature ─── */}
        {hasWallet && (
          <div className="space-y-1">
            <div className="flex items-baseline gap-2 flex-wrap">
              <span className="text-xs uppercase tracking-widest opacity-50">Ownership</span>
              {ownershipSignature && <span className="text-xs text-success">✓ Signed</span>}
            </div>
            {ownershipSignature ? (
              <p className="flex items-center flex-wrap font-mono text-xs opacity-70">
                {ownershipSignature.slice(0, 18)}…{ownershipSignature.slice(-10)}
                <CopyButton value={ownershipSignature} />
              </p>
            ) : (
              <p className="text-xs opacity-50 italic">
                Sign &ldquo;{OWNERSHIP_MESSAGE}&rdquo; to prove control of the destination.
              </p>
            )}
          </div>
        )}

        {/* ─── Sweep status ─── */}
        {hasWallet && (
          <div className="space-y-1">
            <div className="flex items-baseline gap-2 flex-wrap">
              <span className="text-xs uppercase tracking-widest opacity-50">Sweep</span>
              {sweepStatus === "COMPLETED" && (
                <span className="text-xs text-success">✓ Complete</span>
              )}
            </div>
            {sweepStatus === "COMPLETED" ? (
              sweepTxHash ? (
                <a
                  className="link link-primary text-xs"
                  href={`${SEPOLIA_EXPLORER}/tx/${sweepTxHash}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  View on Sepolia Etherscan ↗
                </a>
              ) : (
                <p className="text-xs opacity-70">Tx hash will appear shortly.</p>
              )
            ) : progress ? (
              <p className="text-info text-xs">{progress}</p>
            ) : (
              <p className="text-xs opacity-50">
                {SWEEP_AMOUNT_ETH} ETH from NCW {shortAddr(ncwSourceAddress)} →{" "}
                {shortAddr(primaryWallet?.address)}
              </p>
            )}
          </div>
        )}

        {error && <p className="text-error text-xs">Error: {error}</p>}
      </div>
    </Card>
  );
};
