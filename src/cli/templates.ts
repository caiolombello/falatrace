import {
  BUILT_IN_TEMPLATES, customTemplateIdFromName, isBuiltInTemplateId, type SummaryTemplate, TEMPLATE_MESSAGES, TemplateStore,
  type TemplateStoreOptions
} from "../templates";
import { TEMPLATES_HELP } from "./help";
import { CLI_MESSAGES, CLI_USAGE, type CliIO, parseArgs, printJson, processIO } from "./shared";

export { TEMPLATES_HELP };

export type TemplatesCliDeps = {
  io: CliIO;
  store: () => Pick<TemplateStore, "inspect" | "get" | "save" | "remove" | "path" | "dir">;
};

export const defaultTemplatesCliDeps = (options: TemplateStoreOptions = {}): TemplatesCliDeps => ({
  io: processIO,
  store: () => new TemplateStore(options)
});

const brief = (template: SummaryTemplate) => ({
  id: template.id,
  builtIn: template.builtIn,
  version: template.version,
  name: template.name,
  description: template.description,
  sections: template.sections.map((section) => section.title["pt-BR"])
});

export const runTemplatesCli = async (args: string[], deps: TemplatesCliDeps = defaultTemplatesCliDeps()): Promise<void> => {
  const [, subcommand, ...rest] = args;
  const { io } = deps;
  if (subcommand === "help" || subcommand === "--help") { io.out(TEMPLATES_HELP); return; }
  const store = deps.store();
  if (subcommand === "list") {
    parseArgs(rest);
    const { templates, problems } = await store.inspect();
    printJson(io, { directory: store.dir, templates: [...BUILT_IN_TEMPLATES, ...templates].map(brief), problems });
    return;
  }
  if (subcommand === "show") {
    const [id] = parseArgs(rest).positionals;
    if (!id) throw new Error(CLI_USAGE.templates);
    const template = await store.get(id);
    if (!template) throw new Error(CLI_MESSAGES.templateNotFound);
    printJson(io, template);
    return;
  }
  if (subcommand === "init") {
    const [baseId, ...words] = parseArgs(rest).positionals;
    const name = words.join(" ").trim();
    if (!baseId || !name) throw new Error(CLI_USAGE.templates);
    const base = await store.get(baseId);
    if (!base) throw new Error(CLI_MESSAGES.templateNotFound);
    const id = customTemplateIdFromName(name);
    if (!id) throw new Error(CLI_MESSAGES.templateNameInvalid);
    // A copy the person edits: same sections, keywords and guidance, under their own name.
    const saved = await store.save({ ...base, id, version: 1, builtIn: false, name: { "pt-BR": name, en: name, es: name } });
    printJson(io, { id: saved.id, path: store.path(saved.id), template: saved });
    return;
  }
  if (subcommand === "delete") {
    const [id] = parseArgs(rest).positionals;
    if (!id) throw new Error(CLI_USAGE.templates);
    if (isBuiltInTemplateId(id)) throw new Error(TEMPLATE_MESSAGES.builtInReadOnly);
    printJson(io, { id, deleted: await store.remove(id) });
    return;
  }
  throw new Error(CLI_USAGE.templates);
};
