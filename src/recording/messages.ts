/**
 * Portuguese wording for capture diagnostics shown in the Studio. The CLI keeps the
 * original messages; unknown text is returned unchanged rather than guessed.
 */
const EXACT: Record<string, string> = {
  "OBS recording is disabled; set obs.enabled=true after configuring OBS manually":
    "A gravação pelo OBS está desativada. Configure a cena e o WebSocket no OBS e ative-o em Configurações → Integrações.",
  "OBS recording is restricted to a loopback WebSocket host":
    "O OBS só pode ser controlado neste computador: use 127.0.0.1, localhost ou ::1.",
  "obs.autoLaunch is enabled, but no native or Flatpak OBS launcher was found":
    "Abrir o OBS automaticamente está ativado, mas o OBS não foi encontrado, nem nativo nem Flatpak.",
  "Plasma Wayland recording requires xdg-desktop-portal and its KDE backend":
    "No Plasma Wayland, a gravação precisa do xdg-desktop-portal e do backend do KDE.",
  "Plasma Wayland recording requires PipeWire and WirePlumber tools":
    "No Plasma Wayland, a gravação precisa das ferramentas do PipeWire e do WirePlumber.",
  "Plasma recording remains inert. Configure the OBS scene and WebSocket, then set obs.enabled=true":
    "No Plasma, escolha Só áudio ou Tela e áudio em Captura e áudio, ou configure o OBS.",
  "No compatible recording backend was detected for this desktop session":
    "Nenhum backend de gravação compatível foi detectado nesta sessão. Escolha Só áudio ou Tela e áudio.",
  "The GNOME backend requires a GNOME session and gdbus":
    "O backend GNOME precisa de uma sessão GNOME e do gdbus.",
  "wf-recorder is supported only in a detected wlroots Wayland session":
    "O wf-recorder só funciona em sessões Wayland baseadas em wlroots.",
  "The legacy hybrid backend requires GNOME on X11, gdbus, FFmpeg and xrandr":
    "O backend legado híbrido precisa do GNOME em X11, gdbus, FFmpeg e xrandr.",
  "The legacy ffmpeg-only backend requires GNOME on X11, xdotool and FFmpeg":
    "O backend legado ffmpeg-only precisa do GNOME em X11, xdotool e FFmpeg.",
  "Managed recording requires FFmpeg, ffprobe and systemd user tools":
    "A gravação precisa do FFmpeg, do ffprobe e das ferramentas de usuário do systemd.",
  "Audio recording requires pactl and a PulseAudio-compatible server":
    "A gravação de áudio precisa do pactl e de um servidor compatível com PulseAudio, como o PipeWire.",
  "Audio recording requires microphone or desktop audio":
    "Gravar só áudio exige o microfone ou o áudio do sistema.",
  "GPU Screen Recorder is not installed (native or Flatpak)":
    "O GPU Screen Recorder não está instalado, nem nativo nem Flatpak.",
  "Screen recording requires the desktop portal and its compositor backend":
    "Gravar a tela precisa do portal da área de trabalho e do backend do compositor.",
  "GPU Screen Recorder reports only software H.264; screen capture will require CPU encoding":
    "O GPU Screen Recorder só oferece H.264 por software: escolha a codificação por CPU.",
  "Could not inspect GPU Screen Recorder codecs; validate the encoder before capture":
    "Não foi possível consultar os codecs do GPU Screen Recorder. Teste a codificação antes de gravar.",
  "callDetection.mode=obs overrides the manual backend; use mode=record for the configured backend":
    "O modo OBS da gravação automática ignora o backend escolhido. Use “Gravar automaticamente” para usá-lo.",
  "Automatic call processing is disabled by conflicting enqueue settings":
    "O processamento após a chamada está desligado por opções conflitantes de enfileiramento.",
  "Microphone and desktop must use different audio sources":
    "O microfone e o áudio do sistema precisam ser fontes diferentes.",
  "This backend does not support the shared automatic recording controller":
    "Esse backend não funciona na gravação automática."
};

const PATTERNS: Array<[RegExp, (match: RegExpMatchArray) => string]> = [
  [/^Audio device unavailable: (.+) \((microphone|desktop)\)$/,
    (m) => `Dispositivo de áudio indisponível: ${m[1]}, usado como ${m[2] === "microphone" ? "microfone" : "áudio do sistema"}.`],
  [/^(.+) is a legacy backend and is not selected automatically$/,
    (m) => `${m[1]} é um backend legado e não é escolhido automaticamente.`],
  [/^Backend (.+) has no portable implementation$/,
    (m) => `O backend ${m[1]} não tem implementação disponível. Escolha outro em Captura e áudio.`]
];

export const translateCaptureMessage = (message: string): string => {
  if (EXACT[message]) return EXACT[message];
  for (const [pattern, render] of PATTERNS) {
    const match = message.match(pattern);
    if (match) return render(match);
  }
  return message;
};
