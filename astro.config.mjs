import { defineConfig } from "astro/config";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  site: "https://neroices.github.io",
  base: '/hlcyn',
  vite: {
    plugins: [tailwindcss()],
  },
});