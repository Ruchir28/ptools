import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": new URL("./src/client", import.meta.url).pathname,
    },
  },
  build: {
    outDir: "dist/client",
    emptyOutDir: true,
  },
});
