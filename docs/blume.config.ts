import { defineConfig } from "blume";

// Imp's "Catalogue" look, from client/app.tamber: white paper, black ink, one cobalt accent, square corners.
// Headlines in Instrument Serif, prose in Newsreader, labels and code in IBM Plex Mono (the client's own font files).
const fonts = "../client/assets/fonts";

export default defineConfig({
  title: "Imp",
  description:
    "Your own imp: a self-hosted assistant that runs errands in your apps and builds new ones for you.",
  logo: { image: "/logo.svg", text: "Imp" },
  content: {
    root: "content",
  },
  github: {
    owner: "peelar",
    repo: "imp",
    dir: "docs",
  },
  navigation: {
    cta: { href: "/docs/self-hosting/install", label: "Install" },
  },
  theme: {
    accent: { light: "#2341d6", dark: "#5b74f2" },
    background: { light: "#ffffff", dark: "#0d0d0d" },
    radius: "none",
    fonts: {
      display: {
        name: "Instrument Serif",
        variants: [
          { src: `${fonts}/InstrumentSerif-Regular.ttf`, weight: 400 },
        ],
        fallback: "serif",
      },
      body: {
        name: "Newsreader",
        variants: [
          { src: `${fonts}/Newsreader.ttf` },
          { src: `${fonts}/Newsreader-Italic.ttf`, style: "italic" },
        ],
        fallback: "serif",
      },
      mono: {
        name: "IBM Plex Mono",
        variants: [
          { src: `${fonts}/IBMPlexMono-Regular.ttf`, weight: 400 },
          { src: `${fonts}/IBMPlexMono-Medium.ttf`, weight: 500 },
        ],
      },
    },
  },
  footer: {
    copyright: "Imp is an early prototype. Expect everything to change.",
  },
});
