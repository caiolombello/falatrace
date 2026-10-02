import { describe, expect, test } from "bun:test";
import { StringDecoder } from "node:string_decoder";
import { JsonValueStreamParser } from "../pipewire";

const MAX_JSON_VALUE_BYTES = 16 * 1024 * 1024;

describe("PipeWire JSON parser UTF-8 limit", () => {
  test("rejects a multibyte value above 16 MiB despite fewer UTF-16 code units", () => {
    const input = `["${"é".repeat(9 * 1024 * 1024)}"]`;
    expect(input.length).toBe(9_437_188);
    expect(Buffer.byteLength(input, "utf8")).toBe(18_874_372);
    expect(() => { new JsonValueStreamParser().push(input); }).toThrow("size limit");
  });

  test("accepts exactly 16 MiB with a surrogate pair split between chunks and resets", () => {
    const text = "😀".repeat((MAX_JSON_VALUE_BYTES - 4) / 4);
    const input = `["${text}"]`;
    expect(Buffer.byteLength(input, "utf8")).toBe(MAX_JSON_VALUE_BYTES);
    const parser = new JsonValueStreamParser();
    expect(parser.push(input.slice(0, -3))).toEqual([]);
    expect(parser.push(input.slice(-3))).toEqual([[text]]);
    expect(parser.push('["é"]\n[]')).toEqual([["é"], []]);
  });

  test("rejects one UTF-8 byte above the limit across pushes", () => {
    const prefix = `["${"😀".repeat((MAX_JSON_VALUE_BYTES - 4) / 4)}`;
    const parser = new JsonValueStreamParser();
    expect(parser.push(prefix)).toEqual([]);
    expect(() => parser.push('x"]')).toThrow("size limit");
  });

  test("preserves Unicode and JSON framing at every UTF-8 byte boundary", () => {
    const text = 'ação 😀 [\\] " é';
    const input = Buffer.from(` \n${JSON.stringify([{ text }])}\n[]`, "utf8");
    for (let boundary = 0; boundary <= input.length; boundary += 1) {
      const parser = new JsonValueStreamParser();
      const decoder = new StringDecoder("utf8");
      const values = [
        ...parser.push(decoder.write(input.subarray(0, boundary))),
        ...parser.push(decoder.write(input.subarray(boundary))),
        ...parser.push(decoder.end())
      ];
      expect(values).toEqual([[{ text }], []]);
    }
  });

  test("preserves escaped quotes and brackets across string chunks", () => {
    const text = 'é 😀 [\\] " fim';
    const input = JSON.stringify([{ text }]);
    for (let boundary = 0; boundary <= input.length; boundary += 1) {
      const parser = new JsonValueStreamParser();
      expect([
        ...parser.push(input.slice(0, boundary)),
        ...parser.push(input.slice(boundary))
      ]).toEqual([[{ text }]]);
    }
    expect(() => new JsonValueStreamParser().push('{"id":1}')).toThrow("unexpected JSON value");
  });
});
