import React from "react";

import { GenerateMPCKeys } from "./GenerateMPCKeys";
import { Takeover } from "./Takeover";
import { BackupAndRecover } from "./BackupAndRecover";
import { Assets } from "./Assets";
import { Transactions } from "./Transactions";
import { Web3 } from "./Web3";
import { useAppStore } from "../AppStore";
import { JoinExistingWallet } from "./JoinExistingWallet";
import { Logs } from "./Logs";
import { MigrationFlow } from "./MigrationFlow";
import { KeyMigrationFlow } from "./KeyMigrationFlow";

// Collapsible wrapper used to tuck non-migration cards out of the way so the
// demo leads with the two migration flows. Nothing is removed — it's all here,
// just collapsed by default.
const AdvancedSection: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [open, setOpen] = React.useState(false);
  return (
    <div>
      <button
        type="button"
        className="btn btn-ghost btn-sm normal-case opacity-70"
        onClick={() => setOpen((v) => !v)}
      >
        {open ? "▾" : "▸"} Advanced / debug (sweep migration, raw takeover, Web3, logs)
      </button>
      {open && <div className="mt-2 space-y-4">{children}</div>}
    </div>
  );
};

export const FireblocksNCWExampleActions: React.FC = () => {
  const { keysStatus, joinExistingWalletMode } = useAppStore();
  const secP256K1Status = keysStatus?.MPC_CMP_ECDSA_SECP256K1?.keyStatus ?? null;
  const ed25519Status = keysStatus?.MPC_CMP_EDDSA_ED25519?.keyStatus ?? null;

  const hasAKey = secP256K1Status === "READY" || ed25519Status === "READY";

  return (
    <>
      {joinExistingWalletMode ? <JoinExistingWallet /> : <GenerateMPCKeys />}
      <BackupAndRecover />
      {hasAKey && (
        <>
          <Assets />
          <Transactions />
          {/* ─── Migration demo — key migration is the showcased path ─── */}
          <KeyMigrationFlow />
          {/* ─── Everything else, collapsed by default ─── */}
          <AdvancedSection>
            {/* Alternative: on-chain asset sweep to a fresh Dynamic wallet. */}
            <MigrationFlow />
            {/* Raw Full Key Takeover — KeyMigrationFlow wraps this end-to-end. */}
            <Takeover />
            <Web3 />
            <Logs />
          </AdvancedSection>
        </>
      )}
    </>
  );
};
