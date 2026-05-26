import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: {
          50: "#f5f4ef",
          100: "#e8e6db",
          200: "#cfcab5",
          300: "#a8a085",
          400: "#7a7355",
          500: "#544f3a",
          600: "#3a3628",
          700: "#26241b",
          800: "#171612",
          900: "#0c0b08",
          950: "#070604",
        },
        signal: {
          amber: "#e8a93b",
          ember: "#d96e2a",
          moss: "#8aaa6a",
          rust: "#a04420",
          sea: "#5a8a8a",
        },
      },
      fontFamily: {
        display: ['"Instrument Serif"', "ui-serif", "Georgia", "serif"],
        sans: ['"Geist"', "ui-sans-serif", "system-ui", "sans-serif"],
        mono: ['"JetBrains Mono"', "ui-monospace", "SFMono-Regular", "monospace"],
      },
      letterSpacing: {
        tightest: "-0.04em",
      },
      animation: {
        "pulse-slow": "pulseSlow 2.4s ease-in-out infinite",
        "fade-up": "fadeUp 0.5s cubic-bezier(0.16, 1, 0.3, 1) both",
        "grain": "grain 8s steps(10) infinite",
      },
      keyframes: {
        pulseSlow: {
          "0%, 100%": { opacity: "0.35" },
          "50%": { opacity: "1" },
        },
        fadeUp: {
          "0%": { opacity: "0", transform: "translateY(8px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        grain: {
          "0%, 100%": { transform: "translate(0, 0)" },
          "10%": { transform: "translate(-5%, -10%)" },
          "30%": { transform: "translate(3%, -15%)" },
          "50%": { transform: "translate(12%, 9%)" },
          "70%": { transform: "translate(9%, 4%)" },
          "90%": { transform: "translate(-1%, 7%)" },
        },
      },
    },
  },
  plugins: [],
};
export default config;
