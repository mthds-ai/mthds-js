import type { Command } from "commander";

/**
 * The first word of `args` that names no subcommand of the command group it was
 * given to, or `undefined` when every word up to the leaf command is one.
 *
 * Commander answers `--help` before it rejects an unknown subcommand, so on its own
 * `mthds build output --help` prints the help and exits 0, as if a deleted command
 * were still there. The CLI asks this before it shows the help, and refuses the
 * path instead. The walk follows Commander's dispatch: an option is skipped with
 * the value it takes, from the command it is declared on or any command above it;
 * the walk stops at a leaf command, whose remaining words are its arguments, at
 * `--`, and at Commander's implicit `help` command.
 */
export function findUnknownSubcommand(root: Command, args: readonly string[]): string | undefined {
  const path: Command[] = [root];
  let current = root;
  for (let index = 0; index < args.length; index++) {
    const word = args[index]!;
    if (word === "--") return undefined;
    if (word.startsWith("-")) {
      if (takesNextWord(path, word, args[index + 1])) index++;
      continue;
    }
    if (current.commands.length === 0 || word === "help") return undefined;
    const next = current.commands.find(
      (command) => command.name() === word || command.aliases().includes(word),
    );
    if (next === undefined) return word;
    path.push(next);
    current = next;
  }
  return undefined;
}

/** Whether the option `word` consumes the word after it as its value. */
function takesNextWord(path: readonly Command[], word: string, nextWord?: string): boolean {
  // `--flag=value` carries its value, and so does `-Lvalue` (or a run of short flags).
  if (word.includes("=") || (!word.startsWith("--") && word.length > 2)) return false;
  const option = path
    .flatMap((command) => command.options)
    .find((candidate) => candidate.short === word || candidate.long === word);
  if (option === undefined) return false;
  if (option.required) return true;
  return option.optional && nextWord !== undefined && !nextWord.startsWith("-");
}
