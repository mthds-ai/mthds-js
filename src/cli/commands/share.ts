export interface ShareOptions {
  displayName: string;
  description: string;
  address: string;
}

export function buildShareUrl(options: ShareOptions): string {
  const text = [
    `I just published "${options.displayName}" on mthds.sh! 🚀`,
    "",
    options.description,
    "",
    `Install it: npx mthds install ${options.address}`,
    "",
    "#mthds #AI",
  ].join("\n");

  return `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}`;
}
