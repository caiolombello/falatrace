// Every message the speaker-name suggestions can show, so the Studio can translate
// them and errors from elsewhere are never echoed.

export const SPEAKER_MESSAGES = {
  ready: "Sugestões prontas. Nada muda até você aplicar ou salvar um nome.",
  running: "Procurando nomes em segundo plano",
  interrupted: "A busca de nomes foi interrompida. Tente novamente.",
  needsDiarization: "Identifique os falantes antes de pedir sugestões de nomes",
  startFailed: "Não foi possível iniciar a busca de nomes",
  failed: "Não foi possível sugerir nomes. A gravação e os nomes atuais foram preservados.",
  consentRequired: "Autorize o envio das falas ao modelo configurado antes de procurar nomes na conversa",
  destinationChanged: "O modelo configurado mudou desde a autorização. Revise o destino e tente novamente.",
  mediaUnavailable: "A gravação original não está disponível neste computador para analisar o microfone.",
  mediaChanged: "A mídia diverge da transcrição original; a análise do microfone foi cancelada.",
  microphoneFailed: "Não foi possível analisar o microfone. A gravação foi preservada.",
  conversationEmpty: "Nenhum nome citado com clareza na conversa.",
  "no-separate-tracks": "Esta gravação não tem faixas separadas de microfone e computador.",
  "unrecognized-tracks": "As faixas de áudio desta gravação não seguem o formato do FalaTrace.",
  "no-desktop-audio": "Há pouco áudio do computador para comparar com o microfone.",
  "no-microphone-speech": "Não há fala no microfone nesta gravação.",
  "no-match": "Nenhum falante coincide com a fala no microfone.",
  ambiguous: "Mais de dois falantes aparecem no microfone; sem sugestão pelo microfone.",
  voiceNotInstalled: "Para reconhecer vozes conhecidas, baixe o reconhecimento de voz em Configurações › Modelos.",
  voiceMissing: "As vozes desta gravação ainda não foram calculadas. Use Sugerir nomes…",
  voiceEmpty: "Ainda não há vozes conhecidas: elas são aprendidas quando você confirma um nome.",
  voiceNoMatch: "Nenhuma voz conhecida reconhecida com segurança nesta gravação.",
  voiceFailed: "Não foi possível calcular as vozes desta gravação. A gravação foi preservada."
} as const;

/** Provider and validation failures that are safe to show as they are. */
export const SPEAKER_PROVIDER_ERRORS = [
  "A chave OpenAI não está configurada",
  "A conta OpenAI não autorizou a busca de nomes",
  "O limite da conta OpenAI foi atingido; tente novamente mais tarde",
  "A OpenAI não concluiu a busca de nomes. Nada foi alterado.",
  "O Ollama não respondeu à busca de nomes. Nada foi alterado.",
  "O Ollama precisa usar HTTPS ou um endereço local",
  "O modelo não retornou sugestões válidas",
  "A conversa não cabe no limite de envio do modelo configurado"
] as const;

export const SPEAKER_KNOWN_ERRORS: readonly string[] = [...Object.values(SPEAKER_MESSAGES), ...SPEAKER_PROVIDER_ERRORS];

export const safeSpeakerMessage = (error: unknown, fallback: string = SPEAKER_MESSAGES.failed): string => {
  const message = error instanceof Error ? error.message : "";
  return SPEAKER_KNOWN_ERRORS.includes(message) ? message : fallback;
};
