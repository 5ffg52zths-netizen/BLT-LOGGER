import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
// 変わらない部品(3D の three・React)を別のファイルに分ける。
// アプリ(App.jsx)を更新しても、これらのファイルは前と同じ名前のままなので、見る人の端末は取り直さずに済む。
export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("/node_modules/three/")) return "three";
          if (id.includes("/node_modules/react/") || id.includes("/node_modules/react-dom/") || id.includes("/node_modules/scheduler/")) return "react";
          return undefined;
        },
      },
    },
  },
});
