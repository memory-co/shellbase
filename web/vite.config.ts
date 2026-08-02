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
    // 全部转给后端：网关（静态之外的一切）现在也在同一个进程里
    proxy: {
      "/api": { target: "http://127.0.0.1:8000", ws: true },
      "/tty": { target: "http://127.0.0.1:8000", ws: true },
      "/proxy": { target: "http://127.0.0.1:8000", ws: true },
    },
  },
});
