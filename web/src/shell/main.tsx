import { createRoot } from "react-dom/client";
import "@/index.css";
import { AppProviders } from "@/lib/query";
import { Shell } from "./Shell";

createRoot(document.getElementById("root")!).render(
  <AppProviders>
    <Shell />
  </AppProviders>,
);
