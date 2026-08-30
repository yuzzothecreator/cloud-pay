import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const API_TARGET = process.env.CLOUD_PAY_API ?? "http://localhost:4000";

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: 5173,
    proxy: {
      "/api": {
        target: API_TARGET,
        changeOrigin: true,
      },
    },
  },
});
