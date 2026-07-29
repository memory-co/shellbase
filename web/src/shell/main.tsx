import { createRoot } from "react-dom/client";
import "flexlayout-react/style/dark.css";
import "@/index.css";
import "./flexlayout-theme.css";
import { AppProviders } from "@/lib/query";
import { Shell } from "./Shell";

createRoot(document.getElementById("root")!).render(
  <AppProviders>
    <Shell />
  </AppProviders>,
);
