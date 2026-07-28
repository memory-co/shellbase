import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      input: {
        shell: resolve(__dirname, "index.html"),
        launcher: resolve(__dirname, "apps/launcher.html"),
        files: resolve(__dirname, "apps/files.html"),
        browser: resolve(__dirname, "apps/browser.html"),
      },
    },
  },
  server: {
    proxy: {
      "/api": "http://127.0.0.1:8000",
      "/tty": { target: "http://127.0.0.1:7681", ws: true },
    },
  },
});
