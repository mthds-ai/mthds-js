export interface MethodInfo {
  displayName: string;
  description: string;
}

export interface ShareOptions {
  methods: MethodInfo[];
  address: string;
}

export type SharePlatform = "x" | "reddit" | "linkedin";

export interface ShareUrls {
  x: string;
  reddit: string;
  linkedin: string;
}

function truncate(text: string, maxWords: number): string {
  const words = text.split(/\s+/);
  if (words.length <= maxWords) return text;
  return words.slice(0, maxWords).join(" ") + "...";
}

function buildMethodLine(m: MethodInfo): string {
  return `- ${m.displayName}: ${truncate(m.description, 15)}`;
}

function buildShareText(options: ShareOptions): string {
  const { methods, address } = options;
  const lines: string[] = [];

  if (methods.length === 1) {
    const m = methods[0]!;
    lines.push(
      `I just published "${m.displayName}" on mthds.sh! 🚀`,
      "",
      m.description,
    );
  } else {
    lines.push(
      `I just published ${methods.length} methods on mthds.sh! 🚀`,
      "",
      ...methods.map(buildMethodLine),
    );
  }

  lines.push(
    "",
    `Install: npx mthds install ${address}`,
    "",
    "#mthds #AI",
  );

  return lines.join("\n");
}

function buildTitle(options: ShareOptions): string {
  if (options.methods.length === 1) {
    return `${options.methods[0]!.displayName} — published on mthds.sh`;
  }
  return `${options.methods.length} AI methods published on mthds.sh`;
}

export function buildShareUrls(options: ShareOptions): ShareUrls {
  const text = buildShareText(options);
  const title = buildTitle(options);
  const installUrl = `https://mthds.sh/methods/${options.address}`;

  return {
    x: `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}`,
    reddit: `https://www.reddit.com/submit?type=TEXT&title=${encodeURIComponent(title)}&text=${encodeURIComponent(text + `\n\n${installUrl}`)}`,
    linkedin: `https://www.linkedin.com/feed/?shareActive=true&text=${encodeURIComponent(text + `\n\n${installUrl}`)}`,
  };
}
