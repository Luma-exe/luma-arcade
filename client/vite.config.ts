import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": "http://localhost:7777",
      "/signalling": { target: "ws://localhost:7777", ws: true },
      "/input": { target: "ws://localhost:7777", ws: true },
    },
  },
});
