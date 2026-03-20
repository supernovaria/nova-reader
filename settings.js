// Default settings and shared settings management

const DEFAULT_SETTINGS = {
  // Speed
  wpm: 310,
  wpmStep: 10,

  // Timing multipliers (relative to base word delay)
  commaDelayMultiplier: 1.5,
  periodDelayMultiplier: 2.0,
  semicolonDelayMultiplier: 2.0,
  colonDelayMultiplier: 1.5,
  paragraphDelayMultiplier: 2.5,
  emphasisDelayMultiplier: 1.2, // extra time on bold/italic words
  headingDelayMultiplier: 1.3,  // slow down words inside headings
  headingPauseMs: 150,          // ms pause inserted before & after a heading paragraph
  longWordExtraMs: 0,       // extra ms per character beyond threshold
  longWordThreshold: 8,     // characters before extra delay kicks in

  // Target speed ramp (0 = disabled)
  targetWpm: 0,             // gradually increase toward this WPM
  targetWpmRampMinutes: 5,  // minutes over which to reach target

  // Keybindings
  keyPause: " ",            // spacebar
  keySlower: "s",
  keyFaster: "d",
  keyWordBack: "ArrowLeft",
  keyWordForward: "ArrowRight",
  keyParagraphBack: "ArrowUp",
  keyParagraphForward: "ArrowDown",

  // Appearance
  fontFamily: "'Atkinson Hyperlegible', 'Verdana', 'Trebuchet MS', sans-serif",
  fontSize: 48,             // px
  orpColor: "#e63946",      // red for ORP letter
  textColor: "#1d1d1f",
  backgroundColor: "#fafaf9",
  contextOpacity: 0.18,     // opacity of surrounding text when paused
  contextWords: 12,         // words of context to show on each side when paused
  focusLineColor: "#e63946",
  focusLineWidth: 2,
  focusLineHeight: 16,      // px, height of each focus line segment (above & below text)

  // Ramp-up after unpause
  rampUpWords: 5,           // number of words to ramp over
  rampUpStartFraction: 0.5, // start at this fraction of target WPM (used for long pauses)

  // Dynamic resume speed — ramp-up fraction depends on how long the pause was
  resumeQuickMs: 1000,          // ≤ this ms → quick resume
  resumeQuickFraction: 0.8,     // start at 80% speed (20% cut)
  resumeMediumMs: 2000,         // ≤ this ms → medium resume
  resumeMediumFraction: 0.65,   // start at 65% speed (35% cut)
  // longer pauses use rampUpStartFraction (default 0.5 → 50% cut)

  // Dark mode: "light", "dark", or "system"
  darkMode: "system",
  darkTextColor: "#e8e6e3",
  darkBackgroundColor: "#1a1a1a",
  darkOrpColor: "#ff6b6b",
  darkFocusLineColor: "#ff6b6b",
};

async function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem("novaReaderSettings") || "{}");
    return { ...DEFAULT_SETTINGS, ...saved };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

async function saveSettings(settings) {
  localStorage.setItem("novaReaderSettings", JSON.stringify(settings));
}
