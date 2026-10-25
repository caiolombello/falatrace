import { homedir } from "node:os";

// Splits a custom agent command line into argv the way a POSIX shell would quote it, but
// without running a shell: no variables, globs, pipes or redirections. Anything that would
// mean something special to a shell is refused instead of silently passed through.

export const SHELL_WORDS_MESSAGES = {
  empty: "O comando do agente ACP está vazio.",
  multiline: "O comando do agente ACP deve ficar em uma única linha.",
  unterminated: "O comando do agente ACP tem aspas ou uma barra invertida sem fechamento.",
  shellFeature: "O comando do agente ACP não pode usar recursos de shell (|, &, ;, <, >, $, `, *, ?, #). Use só o programa e seus argumentos.",
  environment: "O comando do agente ACP não pode começar com variáveis de ambiente; use só o programa e seus argumentos.",
  tooLong: "O comando do agente ACP é longo demais."
} as const;

export class ShellWordsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ShellWordsError";
  }
}

const MAX_INPUT = 1000;
const MAX_WORDS = 64;
const SPECIAL = new Set(["|", "&", ";", "<", ">", "(", ")", "$", "`", "*", "?"]);
const DOUBLE_QUOTE_ESCAPES = new Set(["\"", "\\", "$", "`"]);

/** argv from a one-line command. A leading `~` or `~/` in a word means the home directory. */
export const splitShellWords = (input: string, options: { home?: string } = {}): string[] => {
  if (typeof input !== "string" || !input.trim()) throw new ShellWordsError(SHELL_WORDS_MESSAGES.empty);
  if (input.length > MAX_INPUT) throw new ShellWordsError(SHELL_WORDS_MESSAGES.tooLong);
  if (/[\p{Cc}]/u.test(input.replace(/\t/g, " "))) throw new ShellWordsError(SHELL_WORDS_MESSAGES.multiline);
  const home = options.home ?? homedir();
  const words: string[] = [];
  let current = "";
  let inWord = false;
  let i = 0;
  const finish = () => {
    if (!inWord) return;
    if (words.length >= MAX_WORDS || current.length > MAX_INPUT) throw new ShellWordsError(SHELL_WORDS_MESSAGES.tooLong);
    words.push(current);
    current = "";
    inWord = false;
  };
  while (i < input.length) {
    const char = input[i] as string;
    if (char === " " || char === "\t") {
      finish();
      i += 1;
      continue;
    }
    const startOfWord = !inWord;
    inWord = true;
    if (char === "'") {
      const end = input.indexOf("'", i + 1);
      if (end < 0) throw new ShellWordsError(SHELL_WORDS_MESSAGES.unterminated);
      current += input.slice(i + 1, end);
      i = end + 1;
      continue;
    }
    if (char === "\"") {
      i += 1;
      let closed = false;
      while (i < input.length) {
        const inner = input[i] as string;
        if (inner === "\"") { closed = true; i += 1; break; }
        if (inner === "\\" && i + 1 < input.length && DOUBLE_QUOTE_ESCAPES.has(input[i + 1] as string)) {
          current += input[i + 1];
          i += 2;
          continue;
        }
        if (inner === "$" || inner === "`") throw new ShellWordsError(SHELL_WORDS_MESSAGES.shellFeature);
        current += inner;
        i += 1;
      }
      if (!closed) throw new ShellWordsError(SHELL_WORDS_MESSAGES.unterminated);
      continue;
    }
    if (char === "\\") {
      if (i + 1 >= input.length) throw new ShellWordsError(SHELL_WORDS_MESSAGES.unterminated);
      current += input[i + 1];
      i += 2;
      continue;
    }
    if (SPECIAL.has(char) || (char === "#" && startOfWord)) throw new ShellWordsError(SHELL_WORDS_MESSAGES.shellFeature);
    if (char === "~" && startOfWord) {
      const next = input[i + 1];
      // ~user would need the password database; refuse rather than guess.
      if (next !== undefined && next !== "/" && next !== " " && next !== "\t") throw new ShellWordsError(SHELL_WORDS_MESSAGES.shellFeature);
      current += home;
      i += 1;
      continue;
    }
    if (char === "=" && words.length === 0 && /^[A-Za-z_][A-Za-z0-9_]*$/.test(current)) throw new ShellWordsError(SHELL_WORDS_MESSAGES.environment);
    current += char;
    i += 1;
  }
  finish();
  if (words.length === 0 || !words[0]) throw new ShellWordsError(SHELL_WORDS_MESSAGES.empty);
  return words;
};
