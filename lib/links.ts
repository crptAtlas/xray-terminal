/**
 * Where the project points outward. One place, so a handle never ends up
 * living in two files with two different values.
 *
 * An empty string hides that link everywhere it appears: there is no
 * Telegram channel yet, and a link to nothing is worse than no link.
 * Paste the url here and it comes back in the header and the footer.
 */
export const LINKS = {
  x: "https://x.com/crptAtlas",
  github: "https://github.com/crptAtlas/xray-terminal",
  telegram: "",
} as const;
