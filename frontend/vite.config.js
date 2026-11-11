import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import svgr from "vite-plugin-svgr";

// Flask (app.py) serves the built dist/ at http://localhost:5000 -- that's the demo
// setup. While developing, `npm run dev` serves the app on :5173 with hot reload and
// forwards API calls + the Socket.IO websocket to the Flask backend on :5000.
const BACKEND = "http://localhost:5000";

export default defineConfig({
  plugins: [react(), tailwindcss(), svgr()],
  server: {
    port: 5173,
    proxy: {
      "/api": BACKEND,
      "/socket.io": { target: BACKEND, ws: true },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    chunkSizeWarningLimit: 1500,
  },
  test: {
    environment: "node",
  },
});
