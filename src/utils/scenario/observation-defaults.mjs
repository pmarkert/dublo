export const DEFAULT_OBSERVATION_CONFIG = {
  controlsSelector:
    "button, a, input, textarea, select, [role='button'], [role='link'], [role='menuitem'], [role='menuitemcheckbox'], [role='menuitemradio'], [contenteditable='true']",
  maxControls: 80,
  ignoreControlSelectors: ["button[aria-label='Open Tanstack query devtools']"],
  ignoreControlTextPatterns: [],
  priorityControlSelectors: ["nav a", "nav button", "[role='navigation'] a", "[role='navigation'] button"],
  headingSelector: "h1, h2, h3",
  maxHeadings: 10,
  alertSelector: "[role='alert']",
  maxAlerts: 6,
  maxTextNodes: 40,
  textNodeMaxChars: 280,
};