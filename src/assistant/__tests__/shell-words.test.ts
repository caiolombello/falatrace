import { describe, expect, test } from "bun:test";
import { SHELL_WORDS_MESSAGES, ShellWordsError, splitShellWords } from "../providers/shell-words";

const split = (input: string) => splitShellWords(input, { home: "/home/ana" });

describe("splitShellWords", () => {
  test("splits on spaces and tabs like a shell", () => {
    expect(split("agent acp")).toEqual(["agent", "acp"]);
    expect(split("  agent \t --flag   value  ")).toEqual(["agent", "--flag", "value"]);
    expect(split("/opt/bin/my-agent --mode=acp")).toEqual(["/opt/bin/my-agent", "--mode=acp"]);
  });

  test("honours single quotes, double quotes and backslashes", () => {
    expect(split(`'/path with spaces/agent' "--name=Ana Paula" plain\\ word`)).toEqual(["/path with spaces/agent", "--name=Ana Paula", "plain word"]);
    expect(split(`agent 'it''s' "say \\"hi\\"" "back\\\\slash"`)).toEqual(["agent", "its", `say "hi"`, "back\\slash"]);
    // Inside double quotes only \" \\ \$ \` are escapes; other backslashes stay.
    expect(split(`agent "a\\nb"`)).toEqual(["agent", "a\\nb"]);
    expect(split(`agent ''`)).toEqual(["agent", ""]);
    expect(split(`agent "x"'y'z`)).toEqual(["agent", "xyz"]);
    // Characters that are special to a shell are fine once quoted.
    expect(split(`agent '|;&<>$*?#' "#tag" 'a\`b'`)).toEqual(["agent", "|;&<>$*?#", "#tag", "a`b"]);
    expect(split(`agent "cost \\$5"`)).toEqual(["agent", "cost $5"]);
  });

  test("expands a leading ~ to the home directory only at the start of a word", () => {
    expect(split("~/bin/agent acp")).toEqual(["/home/ana/bin/agent", "acp"]);
    expect(split("agent --dir ~ ~/x")).toEqual(["agent", "--dir", "/home/ana", "/home/ana/x"]);
    expect(split("agent a~b '~/q'")).toEqual(["agent", "a~b", "~/q"]);
    expect(() => split("~root/bin/agent")).toThrow(SHELL_WORDS_MESSAGES.shellFeature);
  });

  test("refuses shell features instead of passing them through", () => {
    for (const input of ["agent | tee log", "agent; rm -rf /", "agent && x", "agent > out", "agent < in", "agent $HOME", "agent `id`", "agent $(id)", "agent *.txt", "agent file?", "agent (x)", "agent #comment"]) {
      expect(() => split(input)).toThrow(SHELL_WORDS_MESSAGES.shellFeature);
    }
    // Expansions inside double quotes are shell features too.
    expect(() => split(`agent "$HOME"`)).toThrow(SHELL_WORDS_MESSAGES.shellFeature);
    expect(() => split('agent "`id`"')).toThrow(SHELL_WORDS_MESSAGES.shellFeature);
    // A # inside a word is not a comment.
    expect(split("agent issue#12")).toEqual(["agent", "issue#12"]);
  });

  test("refuses leading environment assignments", () => {
    expect(() => split("API_KEY=secret agent")).toThrow(SHELL_WORDS_MESSAGES.environment);
    expect(split("agent API_KEY=x")).toEqual(["agent", "API_KEY=x"]);
    expect(split("./agent=1")).toEqual(["./agent=1"]);
  });

  test("refuses empty, unterminated, multi-line and oversized input", () => {
    for (const input of ["", "   ", "\t"]) expect(() => split(input)).toThrow(SHELL_WORDS_MESSAGES.empty);
    expect(() => split("''")).toThrow(SHELL_WORDS_MESSAGES.empty);
    expect(() => split("agent 'open")).toThrow(SHELL_WORDS_MESSAGES.unterminated);
    expect(() => split(`agent "open`)).toThrow(SHELL_WORDS_MESSAGES.unterminated);
    expect(() => split("agent \\")).toThrow(SHELL_WORDS_MESSAGES.unterminated);
    expect(() => split("agent\nrm -rf /")).toThrow(SHELL_WORDS_MESSAGES.multiline);
    expect(() => split("agent\u0000x")).toThrow(SHELL_WORDS_MESSAGES.multiline);
    expect(() => split(`agent ${"a".repeat(1000)}`)).toThrow(SHELL_WORDS_MESSAGES.tooLong);
    expect(() => split(Array.from({ length: 65 }, () => "a").join(" "))).toThrow(SHELL_WORDS_MESSAGES.tooLong);
    expect(split(Array.from({ length: 64 }, () => "a").join(" "))).toHaveLength(64);
    expect(() => splitShellWords(42 as unknown as string)).toThrow(ShellWordsError);
  });

  test("errors are ShellWordsError with a Portuguese message from the known list", () => {
    try {
      split("agent | x");
      throw new Error("expected a failure");
    } catch (error) {
      expect(error).toBeInstanceOf(ShellWordsError);
      expect(Object.values(SHELL_WORDS_MESSAGES) as string[]).toContain((error as Error).message);
    }
  });
});
