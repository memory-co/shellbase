import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { "@": resolve(__dirname, "src") },
  },
  build: {
    rollupOptions: {
      input: {
        shell: resolve(__dirname, "index.html"),
        files: resolve(__dirname, "apps/files.html"),
        browser: resolve(__dirname, "apps/browser.html"),
        settings: resolve(__dirname, "apps/settings.html"),
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
