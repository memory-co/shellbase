import { createRoot } from "react-dom/client";
import "../shared/style.css";
import "./shell.css";
import { Shell } from "./Shell";

createRoot(document.getElementById("root")!).render(<Shell />);
