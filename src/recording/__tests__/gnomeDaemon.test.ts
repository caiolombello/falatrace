import { describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG } from "../../config/defaults";
import {
  buildGVariantOptions,
  encodeGVariantString,
  parseScreencastResponse
} from "../gnomeDaemon";

describe("GNOME gdbus adapter", () => {
  test("encodes string and option values as GVariant without a shell", () => {
    expect(encodeGVariantString("a'b\\c\n")).toBe("'a\\'b\\\\c\\n'");
    expect(buildGVariantOptions(DEFAULT_CONFIG)).toBe(
      "{'framerate': <30>, 'draw-cursor': <true>}"
    );
  });

  test("parses a successful screencast response", () => {
    expect(parseScreencastResponse("(true, '/tmp/recording.webm')\n")).toBe(
      "/tmp/recording.webm"
    );
    expect(() => parseScreencastResponse("(false, '')")).toThrow("failed to start");
    expect(() => parseScreencastResponse("invalid")).toThrow("invalid");
  });
});
