import { expect, test } from "bun:test";
import { DEFAULT_CONFIG } from "../../config/defaults";
import {
  CONVERSATION_SYSTEM_PROMPT, buildConversationInput, conversationDestination, destinationKey, suggestFromConversation, validateConversationSuggestions,
  type ConversationTurn
} from "../conversation";

const turns: ConversationTurn[] = [
  { id: "t000000", speaker: "S01", text: "Bom dia, pessoal. Ana, pode começar?" },
  { id: "t000001", speaker: "S02", text: "Claro. Aqui é a Ana Souza, do financeiro." },
  { id: "t000002", speaker: "S03", text: "Eu falei com o Pedro ontem sobre o contrato." },
  { id: "t000003", speaker: "S01", text: "Valeu, Bruno. Vamos seguir." }
];
const speakers = [{ id: "S01", knownAs: "Caio Barbieri" }, { id: "S02" }, { id: "S03" }];
const suggestion = (speakerId: string, name: string, ...evidence: Array<[string, string]>) => ({ speakerId, name, evidence: evidence.map(([turnId, quote]) => ({ turnId, quote })) });

test("keeps a name only when a literal quote from the cited turn contains every word of it", () => {
  const accepted = validateConversationSuggestions({ suggestions: [
    suggestion("S02", "Ana Souza", ["t000001", "Aqui é a Ana Souza"]),
    // Thanked by name right after speaking (t000002): direct address, quoted from the next turn.
    suggestion("S03", "Bruno", ["t000003", "Valeu, Bruno."])
  ] }, turns, speakers);
  expect(accepted).toEqual([
    { speakerId: "S02", name: "Ana Souza", evidence: [{ turnId: "t000001", quote: "Aqui é a Ana Souza" }] },
    { speakerId: "S03", name: "Bruno", evidence: [{ turnId: "t000003", quote: "Valeu, Bruno." }] }
  ]);
});

test("drops invented quotes, surnames without evidence, generic labels, unknown IDs and the owner's name elsewhere", () => {
  const raw = { suggestions: [
    suggestion("S02", "Ana", ["t000001", "Aqui é a Ana Lima"]),            // quote not in the turn
    suggestion("S03", "Pedro Alves", ["t000002", "falei com o Pedro"]),     // surname not quoted
    suggestion("S02", "Falante 2", ["t000001", "Aqui é a Ana Souza"]),      // generic label
    suggestion("S09", "Ana", ["t000001", "Ana Souza"]),                     // unknown speaker
    suggestion("S03", "Ana", ["t000099", "Ana"]),                           // unknown turn
    suggestion("S03", "Caio", ["t000000", "Bom dia"])                       // owner's name for another speaker (and no quote)
  ] };
  expect(validateConversationSuggestions(raw, turns, speakers)).toEqual([]);
  const ownerElsewhere = [...turns, { id: "t000004", speaker: "S03", text: "Obrigado, Caio." }];
  expect(validateConversationSuggestions({ suggestions: [suggestion("S03", "Caio", ["t000004", "Obrigado, Caio."])] }, ownerElsewhere, speakers)).toEqual([]);
  // Accents and case do not matter for the checks; the first suggestion per speaker wins.
  expect(validateConversationSuggestions({ suggestions: [
    suggestion("S02", "ana souza", ["t000001", "AQUI É A ANA SOUZA"]), suggestion("S02", "Outra", ["t000001", "Ana"])
  ] }, turns, speakers)).toEqual([{ speakerId: "S02", name: "ana souza", evidence: [{ turnId: "t000001", quote: "AQUI É A ANA SOUZA" }] }]);
  expect(() => validateConversationSuggestions({ names: [] }, turns, speakers)).toThrow("O modelo não retornou sugestões válidas");
});

test("sends every turn when it fits and otherwise only turns that may carry a name, with their neighbours", () => {
  const all = buildConversationInput(turns, speakers, { max: 100_000, unit: "utf8-bytes" });
  expect(all).toMatchObject({ sentTurns: 4, totalTurns: 4, partial: false });
  expect(JSON.parse(all.content)).toEqual({ speakers, partial: false, turns });
  const long: ConversationTurn[] = Array.from({ length: 400 }, (_, index) => ({ id: `t${String(index).padStart(6, "0")}`, speaker: index % 2 ? "S02" : "S01", text: "sem pistas aqui, só números 123" }));
  long[200] = { id: "t000200", speaker: "S01", text: "obrigado, maria" };
  const partial = buildConversationInput(long, speakers, { max: 2_000, unit: "characters" });
  expect(partial).toMatchObject({ partial: true, sentTurns: 3, totalTurns: 400 });
  expect((JSON.parse(partial.content) as { turns: ConversationTurn[] }).turns.map((turn) => turn.id)).toEqual(["t000199", "t000200", "t000201"]);
  expect(() => buildConversationInput(long, speakers, { max: 10, unit: "characters" })).toThrow("A conversa não cabe");
});

test("the destination is the configured summary model and the consent key changes with it", () => {
  const config = structuredClone(DEFAULT_CONFIG);
  config.summary.provider = "openai";
  config.summary.openaiModel = "gpt-6-luna";
  const openai = conversationDestination(config);
  expect(openai).toEqual({ provider: "openai", model: "gpt-6-luna", endpoint: "https://api.openai.com", external: true });
  config.summary.provider = "ollama";
  config.summary.ollamaUrl = "http://127.0.0.1:11434";
  expect(conversationDestination(config)).toMatchObject({ provider: "ollama", endpoint: "http://127.0.0.1:11434", external: false });
  config.summary.ollamaUrl = "https://ollama.example.com";
  expect(conversationDestination(config).external).toBe(true);
  expect(destinationKey(openai)).toMatch(/^[a-f0-9]{64}$/);
  expect(destinationKey({ ...openai, model: "gpt-5-mini" })).not.toBe(destinationKey(openai));
});

test("one request with the fixed prompt; a reply that is not JSON is refused", async () => {
  const destination = { provider: "openai" as const, model: "gpt-6-luna", endpoint: "https://api.openai.com", external: true };
  const input = buildConversationInput(turns, speakers, { max: 100_000, unit: "utf8-bytes" });
  const requests: Array<{ system: string; user: string; destination: unknown }> = [];
  const result = await suggestFromConversation(destination, input, turns, speakers, async (request) => {
    requests.push(request);
    return JSON.stringify({ suggestions: [suggestion("S02", "Ana", ["t000001", "a Ana Souza"])] });
  });
  expect(result).toEqual([{ speakerId: "S02", name: "Ana", evidence: [{ turnId: "t000001", quote: "a Ana Souza" }] }]);
  expect(requests.map(({ system, user, destination: target }) => ({ system, user, target }))).toEqual([{ system: CONVERSATION_SYSTEM_PROMPT, user: input.content, target: destination }]);
  await expect(suggestFromConversation(destination, input, turns, speakers, async () => "não é json")).rejects.toThrow("O modelo não retornou sugestões válidas");
});
