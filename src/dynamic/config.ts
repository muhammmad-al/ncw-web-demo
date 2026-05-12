import { EthereumWalletConnectors } from "@dynamic-labs/ethereum";
import type { WalletsFilter } from "@dynamic-labs/sdk-react-core";

const onlyEmbeddedWallets: WalletsFilter = (wallets) =>
  wallets.filter((wallet) => wallet.walletConnector.isEmbeddedWallet);

export const dynamicSettings = {
  environmentId: import.meta.env.VITE_DYNAMIC_ENVIRONMENT_ID as string,
  walletConnectors: [EthereumWalletConnectors],
  walletsFilter: onlyEmbeddedWallets,
};
