import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      fontFamily: {
        mono: ["JetBrains Mono", "Fira Code", "ui-monospace", "monospace"],
      },
      // String values set font-size only, matching the `text-[Npx]` classes they replace.
      fontSize: {
        "2xs": "11px",
        "3xs": "10px",
        "4xs": "9px",
        "5xs": "8px",
      },
      colors: {
        surface: {
          DEFAULT: "#0f0f1a",
          card: "#13131f",
          border: "#1e1e32",
          hover: "#1a1a2e",
          page: "#0a0a12",
          base: "#0a0a14",
          banner: "#0b0b14",
          sunken: "#0d0d1a",
          well: "#0d0d16",
          inset: "#0e0e18",
          raised: "#12121f",
          active: "#22223a",
          chip: "#1e1e35",
          "chip-border": "#2e2e4e",
          "border-strong": "#2a2a44",
        },
      },
      // Quarter-step keys (n × 0.25rem), the same numbering Tailwind v4 uses.
      spacing: {
        "27.5": "6.875rem",
        "45": "11.25rem",
        "47.5": "11.875rem",
        "50": "12.5rem",
        "55": "13.75rem",
      },
      height: {
        "65vh": "65vh",
      },
      maxHeight: {
        "60vh": "60vh",
        "80vh": "80vh",
        "92vh": "92vh",
      },
      zIndex: {
        "100": "100",
        "110": "110",
        "120": "120",
      },
      gridTemplateColumns: {
        "label-3": "1fr auto auto auto",
      },
    },
  },
  plugins: [],
};

export default config;
