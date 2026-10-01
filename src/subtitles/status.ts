export type SubtitleUnitStatus = {
  state: "running" | "failed" | "unknown";
  message?: string;
};

/** A collected/missing unit cannot prove that generation started or finished. */
export const subtitleUnitStatus = (output?: string): SubtitleUnitStatus => {
  const active = output?.match(/^ActiveState=(\w+)$/m)?.[1];
  if (active === "active" || active === "activating" || active === "reloading") {
    return { state: "running" };
  }
  if (active === "failed") {
    return {
      state: "failed",
      message: "O serviço de legendas reportou uma falha. A transcrição original foi preservada."
    };
  }
  return {
    state: "unknown",
    message: "Não há legendas alinhadas verificadas. O estado da solicitação está indisponível; a transcrição original foi preservada."
  };
};
