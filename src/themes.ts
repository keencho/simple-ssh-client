import type { ITheme } from "@xterm/xterm";

export interface UiTheme {
  bg: string;
  bg2: string;
  bg3: string;
  bg4: string;
  fg: string;
  fgDim: string;
  accent: string;
  danger: string;
  border: string;
}

export interface TerminalTheme {
  name: string;         // id, stored in config
  displayName: string;  // UI label
  blurb: string;        // 1-liner shown in picker
  group: string;        // category label
  xterm: ITheme;
  ui: UiTheme;
}

// Group identifiers — actual labels resolved via i18n at render time.
const G = {
  essentials: "themes.groups.essentials",
  classic: "themes.groups.classic",
  blue: "themes.groups.blue",
  impact: "themes.groups.impact",
  mac: "themes.groups.mac",
};

// ---------- 21 curated dark themes, ranked ----------

export const THEMES: Record<string, TerminalTheme> = {
  // ============== 1. Modern essentials ==============
  "one-dark-pro": {
    name: "one-dark-pro",
    displayName: "One Dark Pro",
    blurb: "themes.blurbs.one-dark-pro",
    group: G.essentials,
    xterm: {
      background: "#282c34", foreground: "#abb2bf",
      cursor: "#528bff", cursorAccent: "#282c34",
      selectionBackground: "rgba(58, 63, 76, 0.8)",
      black: "#3f4451",      brightBlack: "#4f5666",
      red: "#e06c75",        brightRed: "#e06c75",
      green: "#98c379",      brightGreen: "#98c379",
      yellow: "#e5c07b",     brightYellow: "#e5c07b",
      blue: "#61afef",       brightBlue: "#61afef",
      magenta: "#c678dd",    brightMagenta: "#c678dd",
      cyan: "#56b6c2",       brightCyan: "#56b6c2",
      white: "#abb2bf",      brightWhite: "#e6e6e6",
    },
    ui: { bg: "#282c34", bg2: "#21252b", bg3: "#2c313a", bg4: "#3a404b", fg: "#abb2bf", fgDim: "#6b7280", accent: "#61afef", danger: "#e06c75", border: "#3a404b" },
  },

  "dracula": {
    name: "dracula",
    displayName: "Dracula",
    blurb: "themes.blurbs.dracula",
    group: G.essentials,
    xterm: {
      background: "#282a36", foreground: "#f8f8f2",
      cursor: "#f8f8f2", cursorAccent: "#282a36",
      selectionBackground: "rgba(68, 71, 90, 0.7)",
      black: "#21222c",      brightBlack: "#6272a4",
      red: "#ff5555",        brightRed: "#ff6e6e",
      green: "#50fa7b",      brightGreen: "#69ff94",
      yellow: "#f1fa8c",     brightYellow: "#ffffa5",
      blue: "#bd93f9",       brightBlue: "#d6acff",
      magenta: "#ff79c6",    brightMagenta: "#ff92df",
      cyan: "#8be9fd",       brightCyan: "#a4ffff",
      white: "#f8f8f2",      brightWhite: "#ffffff",
    },
    ui: { bg: "#282a36", bg2: "#1e1f29", bg3: "#343746", bg4: "#44475a", fg: "#f8f8f2", fgDim: "#6272a4", accent: "#bd93f9", danger: "#ff5555", border: "#44475a" },
  },

  "github-dark": {
    name: "github-dark",
    displayName: "GitHub Dark",
    blurb: "themes.blurbs.github-dark",
    group: G.essentials,
    xterm: {
      background: "#0d1117", foreground: "#c9d1d9",
      cursor: "#58a6ff", cursorAccent: "#0d1117",
      selectionBackground: "rgba(56, 139, 253, 0.3)",
      black: "#484f58",      brightBlack: "#6e7681",
      red: "#ff7b72",        brightRed: "#ff7b72",
      green: "#3fb950",      brightGreen: "#56d364",
      yellow: "#d29922",     brightYellow: "#e3b341",
      blue: "#58a6ff",       brightBlue: "#79c0ff",
      magenta: "#bc8cff",    brightMagenta: "#d2a8ff",
      cyan: "#39c5cf",       brightCyan: "#56d4dd",
      white: "#b1bac4",      brightWhite: "#f0f6fc",
    },
    ui: { bg: "#0d1117", bg2: "#010409", bg3: "#161b22", bg4: "#21262d", fg: "#c9d1d9", fgDim: "#8b949e", accent: "#58a6ff", danger: "#ff7b72", border: "#21262d" },
  },

  "tokyo-night": {
    name: "tokyo-night",
    displayName: "Tokyo Night",
    blurb: "themes.blurbs.tokyo-night",
    group: G.essentials,
    xterm: {
      background: "#1a1b26", foreground: "#c0caf5",
      cursor: "#c0caf5", cursorAccent: "#1a1b26",
      selectionBackground: "rgba(40, 52, 87, 0.7)",
      black: "#15161e",      brightBlack: "#414868",
      red: "#f7768e",        brightRed: "#f7768e",
      green: "#9ece6a",      brightGreen: "#9ece6a",
      yellow: "#e0af68",     brightYellow: "#e0af68",
      blue: "#7aa2f7",       brightBlue: "#7aa2f7",
      magenta: "#bb9af7",    brightMagenta: "#bb9af7",
      cyan: "#7dcfff",       brightCyan: "#7dcfff",
      white: "#a9b1d6",      brightWhite: "#c0caf5",
    },
    ui: { bg: "#1a1b26", bg2: "#16161e", bg3: "#24253a", bg4: "#2f334d", fg: "#c0caf5", fgDim: "#565f89", accent: "#7aa2f7", danger: "#f7768e", border: "#2f334d" },
  },

  "catppuccin-mocha": {
    name: "catppuccin-mocha",
    displayName: "Catppuccin Mocha",
    blurb: "themes.blurbs.catppuccin-mocha",
    group: G.essentials,
    xterm: {
      background: "#1e1e2e", foreground: "#cdd6f4",
      cursor: "#f5e0dc", cursorAccent: "#1e1e2e",
      selectionBackground: "rgba(88, 91, 112, 0.6)",
      black: "#45475a",      brightBlack: "#585b70",
      red: "#f38ba8",        brightRed: "#f38ba8",
      green: "#a6e3a1",      brightGreen: "#a6e3a1",
      yellow: "#f9e2af",     brightYellow: "#f9e2af",
      blue: "#89b4fa",       brightBlue: "#89b4fa",
      magenta: "#f5c2e7",    brightMagenta: "#f5c2e7",
      cyan: "#94e2d5",       brightCyan: "#94e2d5",
      white: "#bac2de",      brightWhite: "#a6adc8",
    },
    ui: { bg: "#1e1e2e", bg2: "#181825", bg3: "#313244", bg4: "#45475a", fg: "#cdd6f4", fgDim: "#9399b2", accent: "#94e2d5", danger: "#f38ba8", border: "#313244" },
  },

  // ============== 2. Classic · Muted ==============
  "gruvbox-dark": {
    name: "gruvbox-dark",
    displayName: "Gruvbox Dark (Hard)",
    blurb: "themes.blurbs.gruvbox-dark",
    group: G.classic,
    xterm: {
      background: "#1d2021", foreground: "#ebdbb2",
      cursor: "#ebdbb2", cursorAccent: "#1d2021",
      selectionBackground: "rgba(168, 153, 132, 0.35)",
      black: "#282828",      brightBlack: "#928374",
      red: "#cc241d",        brightRed: "#fb4934",
      green: "#98971a",      brightGreen: "#b8bb26",
      yellow: "#d79921",     brightYellow: "#fabd2f",
      blue: "#458588",       brightBlue: "#83a598",
      magenta: "#b16286",    brightMagenta: "#d3869b",
      cyan: "#689d6a",       brightCyan: "#8ec07c",
      white: "#a89984",      brightWhite: "#ebdbb2",
    },
    ui: { bg: "#1d2021", bg2: "#141617", bg3: "#2a2d2e", bg4: "#3c3836", fg: "#ebdbb2", fgDim: "#a89984", accent: "#fabd2f", danger: "#fb4934", border: "#3c3836" },
  },

  "solarized-dark": {
    name: "solarized-dark",
    displayName: "Solarized Dark",
    blurb: "themes.blurbs.solarized-dark",
    group: G.classic,
    xterm: {
      background: "#002b36", foreground: "#839496",
      cursor: "#93a1a1", cursorAccent: "#002b36",
      selectionBackground: "rgba(7, 54, 66, 0.8)",
      black: "#073642",      brightBlack: "#002b36",
      red: "#dc322f",        brightRed: "#cb4b16",
      green: "#859900",      brightGreen: "#586e75",
      yellow: "#b58900",     brightYellow: "#657b83",
      blue: "#268bd2",       brightBlue: "#839496",
      magenta: "#d33682",    brightMagenta: "#6c71c4",
      cyan: "#2aa198",       brightCyan: "#93a1a1",
      white: "#eee8d5",      brightWhite: "#fdf6e3",
    },
    ui: { bg: "#002b36", bg2: "#001f27", bg3: "#073642", bg4: "#0f4a5b", fg: "#839496", fgDim: "#586e75", accent: "#2aa198", danger: "#dc322f", border: "#073642" },
  },

  "nord": {
    name: "nord",
    displayName: "Nord",
    blurb: "themes.blurbs.nord",
    group: G.classic,
    xterm: {
      background: "#2e3440", foreground: "#d8dee9",
      cursor: "#d8dee9", cursorAccent: "#2e3440",
      selectionBackground: "rgba(76, 86, 106, 0.6)",
      black: "#3b4252",      brightBlack: "#4c566a",
      red: "#bf616a",        brightRed: "#bf616a",
      green: "#a3be8c",      brightGreen: "#a3be8c",
      yellow: "#ebcb8b",     brightYellow: "#ebcb8b",
      blue: "#81a1c1",       brightBlue: "#81a1c1",
      magenta: "#b48ead",    brightMagenta: "#b48ead",
      cyan: "#88c0d0",       brightCyan: "#8fbcbb",
      white: "#e5e9f0",      brightWhite: "#eceff4",
    },
    ui: { bg: "#2e3440", bg2: "#242933", bg3: "#3b4252", bg4: "#434c5e", fg: "#d8dee9", fgDim: "#7b8394", accent: "#88c0d0", danger: "#bf616a", border: "#434c5e" },
  },

  "monokai-pro": {
    name: "monokai-pro",
    displayName: "Monokai Pro",
    blurb: "themes.blurbs.monokai-pro",
    group: G.classic,
    xterm: {
      background: "#2d2a2e", foreground: "#fcfcfa",
      cursor: "#ffd866", cursorAccent: "#2d2a2e",
      selectionBackground: "rgba(115, 113, 118, 0.5)",
      black: "#403e41",      brightBlack: "#727072",
      red: "#ff6188",        brightRed: "#ff6188",
      green: "#a9dc76",      brightGreen: "#a9dc76",
      yellow: "#ffd866",     brightYellow: "#ffd866",
      blue: "#fc9867",       brightBlue: "#fc9867",
      magenta: "#ab9df2",    brightMagenta: "#ab9df2",
      cyan: "#78dce8",       brightCyan: "#78dce8",
      white: "#fcfcfa",      brightWhite: "#fcfcfa",
    },
    ui: { bg: "#2d2a2e", bg2: "#221f22", bg3: "#363336", bg4: "#403e41", fg: "#fcfcfa", fgDim: "#939293", accent: "#ffd866", danger: "#ff6188", border: "#403e41" },
  },

  "kanagawa": {
    name: "kanagawa",
    displayName: "Kanagawa",
    blurb: "themes.blurbs.kanagawa",
    group: G.classic,
    xterm: {
      background: "#1f1f28", foreground: "#dcd7ba",
      cursor: "#c8c093", cursorAccent: "#1f1f28",
      selectionBackground: "rgba(43, 59, 81, 0.6)",
      black: "#16161d",      brightBlack: "#727169",
      red: "#c34043",        brightRed: "#e82424",
      green: "#76946a",      brightGreen: "#98bb6c",
      yellow: "#c0a36e",     brightYellow: "#e6c384",
      blue: "#7e9cd8",       brightBlue: "#7fb4ca",
      magenta: "#957fb8",    brightMagenta: "#938aa9",
      cyan: "#6a9589",       brightCyan: "#7aa89f",
      white: "#c8c093",      brightWhite: "#dcd7ba",
    },
    ui: { bg: "#1f1f28", bg2: "#16161d", bg3: "#2a2a37", bg4: "#363646", fg: "#dcd7ba", fgDim: "#727169", accent: "#7e9cd8", danger: "#c34043", border: "#363646" },
  },

  // ============== 3. Cool blue ==============
  "night-owl": {
    name: "night-owl",
    displayName: "Night Owl",
    blurb: "themes.blurbs.night-owl",
    group: G.blue,
    xterm: {
      background: "#011627", foreground: "#d6deeb",
      cursor: "#80a4c2", cursorAccent: "#011627",
      selectionBackground: "rgba(30, 60, 90, 0.7)",
      black: "#011627",      brightBlack: "#575656",
      red: "#ef5350",        brightRed: "#ef5350",
      green: "#22da6e",      brightGreen: "#22da6e",
      yellow: "#addb67",     brightYellow: "#ffeb95",
      blue: "#82aaff",       brightBlue: "#82aaff",
      magenta: "#c792ea",    brightMagenta: "#c792ea",
      cyan: "#21c7a8",       brightCyan: "#7fdbca",
      white: "#ffffff",      brightWhite: "#ffffff",
    },
    ui: { bg: "#011627", bg2: "#01111d", bg3: "#0b253a", bg4: "#1d3b53", fg: "#d6deeb", fgDim: "#637777", accent: "#82aaff", danger: "#ef5350", border: "#1d3b53" },
  },

  "ayu-dark": {
    name: "ayu-dark",
    displayName: "Ayu Dark",
    blurb: "themes.blurbs.ayu-dark",
    group: G.blue,
    xterm: {
      background: "#0f1419", foreground: "#bfbdb6",
      cursor: "#e6b450", cursorAccent: "#0f1419",
      selectionBackground: "rgba(57, 146, 181, 0.35)",
      black: "#01060e",      brightBlack: "#686868",
      red: "#f07178",        brightRed: "#f07178",
      green: "#aad94c",      brightGreen: "#c2d94c",
      yellow: "#ffb454",     brightYellow: "#ffb454",
      blue: "#59c2ff",       brightBlue: "#59c2ff",
      magenta: "#d2a6ff",    brightMagenta: "#ffa8ff",
      cyan: "#95e6cb",       brightCyan: "#95e6cb",
      white: "#c7c7c7",      brightWhite: "#ffffff",
    },
    ui: { bg: "#0f1419", bg2: "#07080c", bg3: "#1a1f25", bg4: "#273747", fg: "#bfbdb6", fgDim: "#5c6773", accent: "#e6b450", danger: "#f07178", border: "#273747" },
  },

  "palenight": {
    name: "palenight",
    displayName: "Palenight",
    blurb: "themes.blurbs.palenight",
    group: G.blue,
    xterm: {
      background: "#292d3e", foreground: "#bfc7d5",
      cursor: "#ffcc00", cursorAccent: "#292d3e",
      selectionBackground: "rgba(113, 122, 163, 0.4)",
      black: "#292d3e",      brightBlack: "#676e95",
      red: "#ff5572",        brightRed: "#ff6e67",
      green: "#a9c77d",      brightGreen: "#c3e88d",
      yellow: "#ffcb6b",     brightYellow: "#ffd700",
      blue: "#82aaff",       brightBlue: "#82aaff",
      magenta: "#c792ea",    brightMagenta: "#ae81ff",
      cyan: "#89ddff",       brightCyan: "#89ddff",
      white: "#d0d0d0",      brightWhite: "#ffffff",
    },
    ui: { bg: "#292d3e", bg2: "#1f222f", bg3: "#33384d", bg4: "#3a3f58", fg: "#bfc7d5", fgDim: "#676e95", accent: "#c792ea", danger: "#ff5572", border: "#3a3f58" },
  },

  "oceanic-next": {
    name: "oceanic-next",
    displayName: "Oceanic Next",
    blurb: "themes.blurbs.oceanic-next",
    group: G.blue,
    xterm: {
      background: "#1b2b34", foreground: "#d8dee9",
      cursor: "#cdd3de", cursorAccent: "#1b2b34",
      selectionBackground: "rgba(79, 91, 102, 0.6)",
      black: "#343d46",      brightBlack: "#4f5b66",
      red: "#ec5f67",        brightRed: "#ec5f67",
      green: "#99c794",      brightGreen: "#99c794",
      yellow: "#fac863",     brightYellow: "#fac863",
      blue: "#6699cc",       brightBlue: "#6699cc",
      magenta: "#c594c5",    brightMagenta: "#c594c5",
      cyan: "#5fb3b3",       brightCyan: "#5fb3b3",
      white: "#d8dee9",      brightWhite: "#ffffff",
    },
    ui: { bg: "#1b2b34", bg2: "#151f27", bg3: "#253b46", bg4: "#343d46", fg: "#d8dee9", fgDim: "#65737e", accent: "#5fb3b3", danger: "#ec5f67", border: "#343d46" },
  },

  "material-darker": {
    name: "material-darker",
    displayName: "Material Darker",
    blurb: "themes.blurbs.material-darker",
    group: G.blue,
    xterm: {
      background: "#212121", foreground: "#eeffff",
      cursor: "#ffcc00", cursorAccent: "#212121",
      selectionBackground: "rgba(97, 97, 97, 0.5)",
      black: "#212121",      brightBlack: "#545454",
      red: "#ff5370",        brightRed: "#ff5370",
      green: "#c3e88d",      brightGreen: "#c3e88d",
      yellow: "#ffcb6b",     brightYellow: "#ffcb6b",
      blue: "#82aaff",       brightBlue: "#82aaff",
      magenta: "#c792ea",    brightMagenta: "#c792ea",
      cyan: "#89ddff",       brightCyan: "#89ddff",
      white: "#b2b2b2",      brightWhite: "#ffffff",
    },
    ui: { bg: "#212121", bg2: "#171717", bg3: "#2d2d2d", bg4: "#3a3a3a", fg: "#eeffff", fgDim: "#666666", accent: "#82aaff", danger: "#ff5370", border: "#3a3a3a" },
  },

  // ============== 4. Impact · Retro ==============
  "rose-pine-moon": {
    name: "rose-pine-moon",
    displayName: "Rosé Pine Moon",
    blurb: "themes.blurbs.rose-pine-moon",
    group: G.impact,
    xterm: {
      background: "#232136", foreground: "#e0def4",
      cursor: "#e0def4", cursorAccent: "#232136",
      selectionBackground: "rgba(56, 52, 85, 0.6)",
      black: "#393552",      brightBlack: "#817c9c",
      red: "#eb6f92",        brightRed: "#eb6f92",
      green: "#3e8fb0",      brightGreen: "#3e8fb0",
      yellow: "#f6c177",     brightYellow: "#f6c177",
      blue: "#9ccfd8",       brightBlue: "#9ccfd8",
      magenta: "#c4a7e7",    brightMagenta: "#c4a7e7",
      cyan: "#ea9a97",       brightCyan: "#ea9a97",
      white: "#e0def4",      brightWhite: "#e0def4",
    },
    ui: { bg: "#232136", bg2: "#1a1826", bg3: "#2a283e", bg4: "#393552", fg: "#e0def4", fgDim: "#817c9c", accent: "#c4a7e7", danger: "#eb6f92", border: "#393552" },
  },

  "synthwave-84": {
    name: "synthwave-84",
    displayName: "Synthwave '84",
    blurb: "themes.blurbs.synthwave-84",
    group: G.impact,
    xterm: {
      background: "#262335", foreground: "#ffffff",
      cursor: "#ffffff", cursorAccent: "#262335",
      selectionBackground: "rgba(72, 56, 96, 0.6)",
      black: "#000000",      brightBlack: "#495495",
      red: "#fe4450",        brightRed: "#fe4450",
      green: "#72f1b8",      brightGreen: "#72f1b8",
      yellow: "#f97e72",     brightYellow: "#fede5d",
      blue: "#03edf9",       brightBlue: "#03edf9",
      magenta: "#ff7edb",    brightMagenta: "#ff7edb",
      cyan: "#03edf9",       brightCyan: "#03edf9",
      white: "#ffffff",      brightWhite: "#ffffff",
    },
    ui: { bg: "#262335", bg2: "#1a1826", bg3: "#322e46", bg4: "#495495", fg: "#ffffff", fgDim: "#848bbd", accent: "#ff7edb", danger: "#fe4450", border: "#495495" },
  },

  "cobalt2": {
    name: "cobalt2",
    displayName: "Cobalt2",
    blurb: "themes.blurbs.cobalt2",
    group: G.impact,
    xterm: {
      background: "#132738", foreground: "#ffffff",
      cursor: "#f0cb09", cursorAccent: "#132738",
      selectionBackground: "rgba(31, 75, 113, 0.7)",
      black: "#000000",      brightBlack: "#555555",
      red: "#ff0000",        brightRed: "#f40e17",
      green: "#38de21",      brightGreen: "#3bd01d",
      yellow: "#ffe50a",     brightYellow: "#edc809",
      blue: "#1460d2",       brightBlue: "#5555ff",
      magenta: "#ff005d",    brightMagenta: "#ff55ff",
      cyan: "#00bbbb",       brightCyan: "#6ae3fa",
      white: "#bbbbbb",      brightWhite: "#ffffff",
    },
    ui: { bg: "#132738", bg2: "#0d1b24", bg3: "#1f3d55", bg4: "#2c4e6e", fg: "#ffffff", fgDim: "#748a9d", accent: "#ffc600", danger: "#ff0000", border: "#1f3d55" },
  },

  "shades-of-purple": {
    name: "shades-of-purple",
    displayName: "Shades of Purple",
    blurb: "themes.blurbs.shades-of-purple",
    group: G.impact,
    xterm: {
      background: "#2d2b55", foreground: "#ffffff",
      cursor: "#ffd900", cursorAccent: "#2d2b55",
      selectionBackground: "rgba(91, 89, 141, 0.5)",
      black: "#2d2b55",      brightBlack: "#50507a",
      red: "#ec3a37",        brightRed: "#ec3a37",
      green: "#3ad900",      brightGreen: "#3ad900",
      yellow: "#fad000",     brightYellow: "#fad000",
      blue: "#7857fe",       brightBlue: "#7857fe",
      magenta: "#ff2c70",    brightMagenta: "#ff2c70",
      cyan: "#80fcff",       brightCyan: "#80fcff",
      white: "#ffffff",      brightWhite: "#ffffff",
    },
    ui: { bg: "#2d2b55", bg2: "#1e1e3f", bg3: "#3a3872", bg4: "#4d4b8a", fg: "#ffffff", fgDim: "#a599e9", accent: "#fad000", danger: "#ec3a37", border: "#4d4b8a" },
  },

  // ============== 5. Mac classics ==============
  "homebrew": {
    name: "homebrew",
    displayName: "Homebrew",
    blurb: "themes.blurbs.homebrew",
    group: G.mac,
    xterm: {
      background: "#000000", foreground: "#00ff00",
      cursor: "#00ff00", cursorAccent: "#000000",
      selectionBackground: "rgba(0, 150, 0, 0.4)",
      black: "#000000",      brightBlack: "#666666",
      red: "#990000",        brightRed: "#e50000",
      green: "#00a600",      brightGreen: "#00d900",
      yellow: "#999900",     brightYellow: "#e5e500",
      blue: "#0000b2",       brightBlue: "#0000ff",
      magenta: "#b200b2",    brightMagenta: "#e500e5",
      cyan: "#00a6b2",       brightCyan: "#00e5e5",
      white: "#bfbfbf",      brightWhite: "#e5e5e5",
    },
    ui: { bg: "#000000", bg2: "#000000", bg3: "#0a0a0a", bg4: "#1a1a1a", fg: "#00ff00", fgDim: "#006600", accent: "#00ff00", danger: "#e50000", border: "#1a1a1a" },
  },

  "pro-macos": {
    name: "pro-macos",
    displayName: "Pro (macOS)",
    blurb: "themes.blurbs.pro-macos",
    group: G.mac,
    xterm: {
      background: "#000000", foreground: "#f2f2f2",
      cursor: "#4d4d4d", cursorAccent: "#f2f2f2",
      selectionBackground: "rgba(70, 70, 70, 0.6)",
      black: "#000000",      brightBlack: "#666666",
      red: "#990000",        brightRed: "#e50000",
      green: "#00a600",      brightGreen: "#00d900",
      yellow: "#999900",     brightYellow: "#e5e500",
      blue: "#2009db",       brightBlue: "#1f1fe1",
      magenta: "#b200b2",    brightMagenta: "#e500e5",
      cyan: "#00a6b2",       brightCyan: "#00e5e5",
      white: "#bfbfbf",      brightWhite: "#e5e5e5",
    },
    ui: { bg: "#000000", bg2: "#000000", bg3: "#141414", bg4: "#2a2a2a", fg: "#f2f2f2", fgDim: "#808080", accent: "#2009db", danger: "#e50000", border: "#2a2a2a" },
  },
};

// Display order = ranking (1 = first).
export const THEME_ORDER: string[] = [
  // Modern essentials
  "one-dark-pro",
  "dracula",
  "github-dark",
  "tokyo-night",
  "catppuccin-mocha",
  // Classic · Muted
  "gruvbox-dark",
  "solarized-dark",
  "nord",
  "monokai-pro",
  "kanagawa",
  // Cool blue
  "night-owl",
  "ayu-dark",
  "palenight",
  "oceanic-next",
  "material-darker",
  // Impact · Retro
  "rose-pine-moon",
  "synthwave-84",
  "cobalt2",
  "shades-of-purple",
  // Mac classics
  "homebrew",
  "pro-macos",
];

// Group definitions in display order (for picker section headers).
export const THEME_GROUPS: Array<{ label: string; names: string[] }> = [
  { label: G.essentials, names: ["one-dark-pro", "dracula", "github-dark", "tokyo-night", "catppuccin-mocha"] },
  { label: G.classic,    names: ["gruvbox-dark", "solarized-dark", "nord", "monokai-pro", "kanagawa"] },
  { label: G.blue,       names: ["night-owl", "ayu-dark", "palenight", "oceanic-next", "material-darker"] },
  { label: G.impact,     names: ["rose-pine-moon", "synthwave-84", "cobalt2", "shades-of-purple"] },
  { label: G.mac,        names: ["homebrew", "pro-macos"] },
];

export const DEFAULT_THEME = "one-dark-pro";

export function getTheme(name: string | null | undefined): TerminalTheme {
  if (name && THEMES[name]) return THEMES[name];
  return THEMES[DEFAULT_THEME];
}

export function applyUiTheme(ui: UiTheme) {
  const r = document.documentElement.style;
  r.setProperty("--bg", ui.bg);
  r.setProperty("--bg-2", ui.bg2);
  r.setProperty("--bg-3", ui.bg3);
  r.setProperty("--bg-4", ui.bg4);
  r.setProperty("--fg", ui.fg);
  r.setProperty("--fg-dim", ui.fgDim);
  r.setProperty("--accent", ui.accent);
  r.setProperty("--danger", ui.danger);
  r.setProperty("--border", ui.border);
}

// ---------- Font options ----------
// Ranked by 2024-2025 developer popularity (dev surveys, GitHub stars, font rankings).

export interface FontOption {
  label: string;     // stored in config, shown in UI
  value: string;     // css font-family value (with fallbacks)
  blurb?: string;    // description shown in UI
  bundled?: boolean; // true = shipped via @fontsource, always available offline
  cdnUrl?: string;   // Google Fonts CSS URL for on-demand preview (if not installed)
  installUrl?: string; // official download / info page
}

// Proprietary fonts (MonoLisa, Input Mono), OS-exclusive fonts (Consolas,
// Menlo, Courier New), and ambiguous-license fonts (Ubuntu Mono) have been
// removed. We cannot bundle them legally, and relying on system presence is
// unreliable across platforms.
export const FONTS: FontOption[] = [
  // ----- Bundled (S-tier, OFL, shipped via @fontsource) -----
  { label: "Fira Code",         value: '"Fira Code", "Cascadia Code", monospace',       bundled: true, blurb: "Mozilla · 1,500+ 리거처",               installUrl: "https://github.com/tonsky/FiraCode/releases" },
  { label: "JetBrains Mono",    value: '"JetBrains Mono", "Cascadia Code", monospace',  bundled: true, blurb: "IntelliJ · 139 리거처, 큰 x-height",   installUrl: "https://www.jetbrains.com/lp/mono/" },
  { label: "Cascadia Code",     value: '"Cascadia Code", "Cascadia Mono", monospace',   bundled: true, blurb: "MS · Win11 기본, 리거처 지원",         installUrl: "https://github.com/microsoft/cascadia-code/releases" },
  { label: "Source Code Pro",   value: '"Source Code Pro", "Cascadia Mono", monospace', bundled: true, blurb: "Adobe 클래식, 작은 크기 최적",         installUrl: "https://github.com/adobe-fonts/source-code-pro/releases" },

  // ----- Non-bundled OFL fonts (installed on system or CDN-preview) -----
  { label: "Monaspace Neon",    value: '"Monaspace Neon", "Cascadia Code", monospace',  blurb: "GitHub · 5 패밀리 texture healing",  installUrl: "https://monaspace.githubnext.com/" },
  { label: "Monaspace Argon",   value: '"Monaspace Argon", "Cascadia Code", monospace', blurb: "GitHub Monaspace 휴머니스트",         installUrl: "https://monaspace.githubnext.com/" },
  { label: "Maple Mono",        value: '"Maple Mono", "Cascadia Code", monospace',      blurb: "2024 신작 · 아시아 개발자 인기",     installUrl: "https://github.com/subframe7536/maple-font/releases" },
  { label: "Commit Mono",       value: '"Commit Mono", "Cascadia Code", monospace',     blurb: "기호 커닝 최적화",                    installUrl: "https://commitmono.com/" },
  { label: "Cascadia Mono",     value: '"Cascadia Mono", "Consolas", monospace',
    cdnUrl: "https://fonts.googleapis.com/css2?family=Cascadia+Mono:wght@400;700&display=swap",
    blurb: "Cascadia 리거처 없는 버전",                                                   installUrl: "https://github.com/microsoft/cascadia-code/releases" },
  { label: "DejaVu Sans Mono",  value: '"DejaVu Sans Mono", monospace',                 blurb: "Linux 표준, 유니코드 광범위",        installUrl: "https://dejavu-fonts.github.io/Download.html" },
  { label: "Hack",              value: '"Hack", "Cascadia Mono", monospace',            blurb: "Bitstream 기반, 심볼 강점",          installUrl: "https://sourcefoundry.org/hack/" },
  { label: "Roboto Mono",       value: '"Roboto Mono", "Cascadia Mono", monospace',
    cdnUrl: "https://fonts.googleapis.com/css2?family=Roboto+Mono:wght@400;700&display=swap",
    blurb: "Google, sans serif 느낌",                                                    installUrl: "https://fonts.google.com/specimen/Roboto+Mono" },
  { label: "IBM Plex Mono",     value: '"IBM Plex Mono", "Cascadia Mono", monospace',
    cdnUrl: "https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;700&display=swap",
    blurb: "IBM 오픈소스",                                                                installUrl: "https://github.com/IBM/plex/releases" },
  { label: "Inconsolata",       value: '"Inconsolata", "Cascadia Mono", monospace',
    cdnUrl: "https://fonts.googleapis.com/css2?family=Inconsolata:wght@400;700&display=swap",
    blurb: "핸드힌팅 · 엘레강트",                                                        installUrl: "https://fonts.google.com/specimen/Inconsolata" },

  // ----- OS fallback -----
  { label: "시스템 monospace",   value: 'ui-monospace, SFMono-Regular, monospace', bundled: true, blurb: "OS 기본 monospace" },
];

export const DEFAULT_FONT = "Cascadia Code";

export function getFontValue(label: string | null | undefined): string {
  const target = label ?? DEFAULT_FONT;
  return FONTS.find((f) => f.label === target)?.value ?? FONTS[0].value;
}

// 한글 고정폭 폴백. 위 FONTS의 Latin 폰트들에는 한글 글리프가 없어서 그냥 두면
// 시스템 맑은 고딕으로 떨어지는데, 맑은 고딕은 고정폭이 아니라서 한글 폭이
// xterm 셀 격자의 정확히 2배가 아니다(= 한글 줄이 격자에서 어긋난다).
// 나눔고딕코딩은 번들되어 있고 한글 = Latin 2배로 설계돼 격자에 맞는다.
export const KOREAN_FALLBACK_FONT = '"Nanum Gothic Coding"';

const GENERIC_FAMILY = /^(ui-)?(monospace|sans-serif|serif)$|^system-ui$|^SFMono-Regular$/;

// 스택의 첫 generic family 바로 앞에 한글 폴백을 끼워 넣는다.
// generic보다 뒤에 두면 브라우저가 generic에서 이미 글리프를 찾아버려 무시된다.
// 터미널에 실제로 먹이는 값에만 적용한다 — FONTS의 원본 value는 설정 화면의
// "설치됨/미설치" 판정(resolveActualFont)에 쓰이므로 건드리지 않는다.
export function withKoreanFallback(stack: string): string {
  if (stack.includes(KOREAN_FALLBACK_FONT)) return stack;
  const parts = stack.split(",").map((s) => s.trim());
  const at = parts.findIndex((p) => GENERIC_FAMILY.test(p.replace(/^["']|["']$/g, "")));
  if (at < 0) parts.push(KOREAN_FALLBACK_FONT);
  else parts.splice(at, 0, KOREAN_FALLBACK_FONT);
  return parts.join(", ");
}
