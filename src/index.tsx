import ReactDOM from "react-dom/client";
import { DynamicContextProvider } from "@dynamic-labs/sdk-react-core";
import { App } from "./App";
import { dynamicSettings } from "./dynamic/config";
import "./index.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <DynamicContextProvider settings={dynamicSettings}>
    <App />
  </DynamicContextProvider>,
);
