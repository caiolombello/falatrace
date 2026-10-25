/**
 * Share: shareable Markdown for a meeting or a recipe result. Destinations (Obsidian, Notion,
 * Slack, clipboard, AI apps) live in src/destinations and take a RenderedShare from here.
 */
export {
  SHARE_INCLUDES,
  SHARE_KNOWN_ERRORS,
  SHARE_KNOWN_WARNINGS,
  SHARE_LANGUAGES,
  SHARE_LIMITS,
  SHARE_MESSAGES,
  SHARE_WARNINGS,
  ShareError,
  assertRenderedShare,
  escapeInline,
  formatLocalDateTime,
  isShareInclude,
  isShareLanguage,
  parseInlineMarkdown,
  readFrontmatterValue,
  recordingLink,
  renderShare,
  renderShareMarkdown,
  renderTextShare,
  validateShareNote,
  yamlString
} from "./render";
export type {
  InlineSegment,
  RenderedShare,
  ShareAction,
  ShareErrorCode,
  ShareInclude,
  ShareItem,
  ShareLanguage,
  ShareMessage,
  ShareNote,
  ShareRenderOptions,
  ShareSection,
  ShareTranscriptLine,
  TextShareInput
} from "./render";
