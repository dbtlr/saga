import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [tanstackStart(), react()],
  server: {
    host: "127.0.0.1",
    port: 4767,
    strictPort: true,
  },
});
