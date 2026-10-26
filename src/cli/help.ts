import { KEYS_HELP } from "./keys";
import { MODELS_HELP } from "./models";
import { REVIEW_EXPORT_HELP } from "./review-export";
import { REVIEWED_SNAPSHOT_HELP } from "./reviewed-snapshots";

/**
 * Text of `falatrace help`: a short overview grouped by task, and the details of each command
 * family (`falatrace help <command>`). The family modules re-export their constant from here, so
 * printing the help never loads the modules behind the commands.
 */

export const NOTES_HELP = `Notas da reunião (o bloco de notas; ficam neste computador):
  notes show <id> [--json]       Mostra as notas de uma reunião (id do job ou da captura)
  notes edit <id> [--rev N] [--clear]
                                 Troca as notas pelo texto da entrada padrão e mostra o que foi salvo;
                                 --rev recusa salvar se as notas mudaram depois daquela revisão;
                                 uma entrada vazia só apaga notas existentes com --clear
  notes path <id>                Caminho do arquivo das notas
`;

export const TEMPLATES_HELP = `Modelos de resumo (as seções que o resumo segue):
  templates list                 Modelos embutidos e personalizados (JSON)
  templates show <id>            Um modelo completo (JSON)
  templates init <id-base> <nome>
                                 Cria um modelo personalizado a partir de outro; edite o arquivo mostrado
  templates delete <id>          Apaga um modelo personalizado
`;

export const ASK_HELP = `Perguntar às reuniões (o assistente responde só com trechos das gravações e cita cada um):
  ask [--meeting <job-id>|--person <id>|--client <código>] [--yes] [--json] <pergunta>
                                 Sem opção, pergunta à biblioteca toda. O destino é mostrado antes do
                                 envio; destinos fora deste computador exigem --yes. A resposta sai na
                                 saída padrão, seguida das citações:
                                 [n] <título> <data> <mm:ss> <job-id>#<trecho>
                                 --json imprime {text, citations, destination}
`;

export const RECIPES_HELP = `Receitas (tarefas prontas para o assistente: e-mail de follow-up, riscos, ata...):
  recipes list                   Receitas embutidas e personalizadas (JSON)
  recipes show <id>              Uma receita completa (JSON)
  recipes run <id> [--meeting <job-id>|--person <id>|--client <código>] [--yes] [--json]
                                 Roda a receita como uma pergunta (mesmo destino e consentimento de ask);
                                 receitas de reunião exigem --meeting
`;

export const SHARE_HELP = `Compartilhar as notas de uma reunião:
  share <job-id> --to clipboard|obsidian|notion|slack|ai-app
        [--include summary|summary+notes|full] [--dry-run] [--yes]
                                 --dry-run mostra o Markdown e não envia nada. Notion, Slack e ai-app
                                 levam o conteúdo para fora deste computador e exigem --yes. Os destinos ficam
                                 em destinations.* (e NOTION_TOKEN / SLACK_WEBHOOK_URL em keys)
`;

export const PEOPLE_HELP = `Pessoas (nomes de falantes confirmados e convidados da agenda):
  people list [--all]            Pessoas, das mais recentes às mais antigas (JSON); --all inclui ocultas
  people show <id>               Reuniões, decisões e ações de uma pessoa (JSON)
  people rename <id> <nome>      Novo nome (o anterior vira apelido)
  people merge <de> <para>       Junta duas pessoas
  people alias <id> add|remove <apelido>
  people hide|unhide <id>        Oculta das listas, ou mostra de novo
`;

export const CLIENTS_HELP = `Clientes (catálogo em timesheet.contextPath):
  clients list                   Clientes do catálogo, com reuniões e ações abertas (contagens, JSON)
  clients show <código>          Reuniões, decisões, ações e pessoas de um cliente (JSON)
  clients add <nome> [--code C] [--alias A]...
                                 Adiciona ao catálogo (com cópia de segurança do arquivo)
  clients rename <código> <nome>
  clients delete <código>
  clients assign <job-id> <código...> | --auto
                                 Define os clientes de uma gravação, ou volta à escolha automática
`;

export const ACTIONS_HELP = `Ações combinadas nas reuniões (o estado fica neste computador):
  actions list [--status open|done|all] [--person ID] [--client CÓDIGO] [--meeting JOB] [--json]
                                 Abertas por padrão; cada linha termina com <mídia>:<id>
  actions done <mídia>:<id>      Marca como feita
  actions reopen <mídia>:<id>    Reabre
  actions dismiss <mídia>:<id>   Descarta
`;

export const REMINDERS_HELP = `Lembretes antes das reuniões da agenda (reminders.*):
  reminders status               Modo em vigor, agendas e estado do serviço (JSON)
  reminders test                 O que seria avisado nas próximas 3 h (não mostra nem envia nada)
  reminders install-service      Instala e inicia o serviço do usuário
  reminders uninstall-service    Para e remove o serviço
  reminders run                  O laço do serviço (usado pelo serviço do systemd)
`;

export const LIVE_HELP = `Transcrição ao vivo (live.*; uma prévia, a transcrição final é feita depois):
  live show <sessão> [--follow] [--json]
                                 Linhas já transcritas; --follow acompanha até a captura parar
  live run --session <uuid>      O trabalhador da transcrição (usado pela unidade temporária)
`;

export const MEDIA_HELP = `Mídia das gravações (media.retention; a transcrição é sempre mantida):
  media status <job-id>          Mídia presente, removida, só com áudio ou ausente (JSON)
  media retention [--dry-run|--apply] [--limit N]
                                 Prévia (padrão) ou aplicação da política; --apply também conclui
                                 remoções interrompidas, mesmo com a política "keep"
  media remove <job-id> [--keep-audio] [--json] --yes
                                 Remove a mídia agora e mantém a transcrição (e o áudio, com --keep-audio)
`;

export const STUDIO_HELP = `FalaTrace Studio:
  studio open <link>             Abre falatrace://recording/<id>, falatrace://event/<hash> ou
                                 falatrace://capture (no Studio aberto, ou abrindo o Studio)
`;

export const NOTIFY_HELP = `Notificações com botões (internas, usadas por unidades temporárias):
  notify ready --job <uuid>      "Notas prontas", com um botão que abre a gravação no Studio
  notify reminder --event <hash> Mostra o lembrete registrado e aplica o botão escolhido
`;

export const ASSISTANT_HELP = `Assistente (assistant.*: Ollama local, API, agentes ACP, CLIs de assinatura ou ChatGPT):
  assistant status               Provedor, destino e se está pronto (JSON; não envia reuniões)
  assistant detect               Agentes e CLIs encontrados no PATH (JSON; nada é baixado)
  assistant models               Modelos do provedor configurado (JSON)
  assistant login-chatgpt        Entrar com o ChatGPT: mostra o endereço e espera o retorno do navegador
  assistant logout-chatgpt       Esquece os tokens do ChatGPT
`;

export const LIBRARY_HELP = `Índice local da biblioteca (base de pessoas, clientes, ações e perguntas):
  library refresh                Atualiza o índice com as gravações processadas (JSON)
  library search <consulta> [--limit N]
                                 Trechos que respondem à consulta (JSON)
`;

const RECORD_HELP = `Recording:
  record doctor [--backend <audio|gpu-screen-recorder|obs>]  Inspect backends without starting capture
  record start                   Start a recording (review consent and providers first)
  record stop                    Stop and enqueue the current recording
  record status                  Show recording status
  record recover                 Finalize an interrupted capture
  record reset [--force]         Clear local recording state
  record check <file>            Check audio tracks and silence locally
  record logs                    Recent capture log lines
Recording options:
  --backend <audio|gpu-screen-recorder|obs>
  --microphone <device-name>
  --desktop-source <device-name>
  --capture-profile <standard|call-light>  Explicit video quality tradeoff (GPU only)
  --encoder <gpu|cpu>
  --title <name>
  --duration-mins <mins>
  --geometry <WxH+X+Y>
  --audio <none|microphone|desktop|both>
  --monitor <id|all>
  --foreground
  --force
`;

const PROCESSING_HELP = `Processing:
  transcribe <file>              Create and start a processing job
  jobs list                      List local jobs
  jobs status <id>               Show a job (JSON, with artifact states)
  jobs process <id>              Process one selected job
  jobs sync                      Send pending jobs, fetch results, then apply media retention
  jobs retry <id>                Retry a failed job
  jobs cleanup [--dry-run]       Preview or apply eligible local retention cleanup
  jobs install-timer | uninstall-timer
  remote check                   Check the configured worker host
  worker run | once | install    Run, run once or install the processing worker
  processing-status              Processing admission (JSON; wait reasons and policy)
Processing options:
  --target <local|remote>
  --transcriber <whisper-cpp|openai|gemini>
  --summarizer <openai|ollama>
`;

const SPEAKERS_HELP = `Speaker diarization:
  diarization queue <job-id>     Identify speakers in the background
  diarization status <job-id>    Show speaker processing state
  diarization name <job-id> <S01> <name>  Name a speaker in this recording
  speakers suggest <job-id> [--conversation]  Suggest names: microphone track (local);
                                 --conversation also sends the turns to the summary model
  speakers queue <job-id>        Suggest names in the background (microphone only)
  speakers status <job-id>       Show name suggestions; nothing is applied automatically
`;

const GOOGLE_HELP = `Google Calendar (google.clientId and GOOGLE_CLIENT_SECRET from your own Cloud project):
  google connect                 Sign in through the browser; the refresh token stays in a private file
  google status | disconnect     Show the connection, or revoke it and delete the token
`;

const VOICES_HELP = `Known voices (speakers.voices; signatures only, never audio):
  voices list                    People FalaTrace can recognize and how many samples each has
  voices delete <id> | --all     Forget one person or everyone, with every learned signature
`;

const ARCHIVE_HELP = `Original media backup:
  archive status [id]            Show remote worker and Proton media copies
  archive add <file>             Register one finalized original
  archive backfill               Register existing local recordings
  archive import-remote          Catalog verified originals already on remote worker
  archive recover-remote         Copy retained originals from failed remote jobs
  archive sync [id]              Retry independent original media copies
  archive restore <id>           Restore and verify a Proton original
  archive install-timer | uninstall-timer
  backup proton <job-id>         Back up one completed job to Proton Drive
  backup sync                    Back up eligible completed jobs
  backup status [job-id]         Show persistent Proton backup state
  backup install-timer | uninstall-timer
  subtitles queue <id>           Generate aligned captions on remote worker in background
  subtitles create <id>          Generate aligned captions now
`;

const CALLS_HELP = `Call detection and tray:
  calls inspect                  Show sanitized call-detection signals
  calls run [--dry-run]          Monitor calls in the foreground
  calls status                   Show current call-monitor state (JSON)
  calls pause                    Suspend new automatic recordings (record stop ends the active capture)
  calls resume                   Resume recording for future calls
  calls install-service          Install and start the user service
  calls uninstall-service        Disable and remove the user service
  calls validate <app-open|in-call|ended> [--session <name>]
  calls validation-report [--session <name>]
  tray run | install-service | uninstall-service
`;

const CONTEXT_HELP = `Context for agents (local, bounded, untrusted meeting data):
  context search <query> [--client --since --until --limit 1..100]  Search meetings as JSON
  context meeting <job-id> [--query --offset --max-characters 4096..24000]  Read bounded context as JSON
  context build [--client <client>]  Rebuild derived local memory
  context list | show <client> | path <client> | prompt <client>
  agent-context capabilities     Local candidate frame retrieval capabilities
  agent-context serve            MCP stdio server
`;

const TIME_HELP = `Time entries:
  time list [--date <YYYY-MM-DD>]  List local time entries
  time show <id>                 Show a time entry
  time start | stop              Start or stop the manual timer
  time add                       Add a time entry
  time edit <id>                 Edit a time entry
  time delete <id> --yes         Delete a local time entry
  time classify <id>             Retry AI classification
  time init-context | context    Create an empty local catalog / show its path and counts
Time entry options:
  --date <YYYY-MM-DD>
  --start <HH:MM>
  --end <HH:MM>
  --hours <decimal>
  --client <code|name|alias>
  --type <id|slug|name>
  --card <DEV-123>
  --description <text>
`;

const LEGACY_HELP = `Legacy and internal:
  upload <file>                  Legacy cloud upload
  upload-all                     Legacy bulk cloud upload
  s3 play                        List S3 videos and play with the recording player
  monitors                       List available monitors
  desktop bridge | playback      Studio internals
  tui [--section library|timesheet]  Browse recordings and time entries
`;

/** `falatrace help <command>`: the details of a command family. */
const COMMAND_HELP: Record<string, string> = {
  notes: NOTES_HELP, templates: TEMPLATES_HELP, ask: ASK_HELP, recipes: RECIPES_HELP, share: SHARE_HELP,
  people: PEOPLE_HELP, clients: CLIENTS_HELP, actions: ACTIONS_HELP, reminders: REMINDERS_HELP, live: LIVE_HELP,
  media: MEDIA_HELP, studio: STUDIO_HELP, notify: NOTIFY_HELP, assistant: ASSISTANT_HELP, library: LIBRARY_HELP,
  keys: KEYS_HELP, models: MODELS_HELP, review: REVIEW_EXPORT_HELP, export: REVIEW_EXPORT_HELP,
  "summary-review": REVIEWED_SNAPSHOT_HELP, "removal-plan": REVIEWED_SNAPSHOT_HELP,
  record: RECORD_HELP, transcribe: PROCESSING_HELP, jobs: PROCESSING_HELP, worker: PROCESSING_HELP, remote: PROCESSING_HELP,
  "processing-status": PROCESSING_HELP, diarization: SPEAKERS_HELP, speakers: SPEAKERS_HELP, google: GOOGLE_HELP, voices: VOICES_HELP,
  archive: ARCHIVE_HELP, backup: ARCHIVE_HELP, subtitles: ARCHIVE_HELP, calls: CALLS_HELP, tray: CALLS_HELP,
  context: CONTEXT_HELP, knowledge: CONTEXT_HELP, "agent-context": CONTEXT_HELP, time: TIME_HELP, timesheet: TIME_HELP,
  upload: LEGACY_HELP, "upload-all": LEGACY_HELP, s3: LEGACY_HELP, monitors: LEGACY_HELP, desktop: LEGACY_HELP, tui: LEGACY_HELP
};

export const commandHelp = (command: string | undefined): string | undefined =>
  command !== undefined && Object.getOwnPropertyDescriptor(COMMAND_HELP, command) !== undefined ? COMMAND_HELP[command] : undefined;

/** Commands with their own help text, in the order of the overview. */
export const HELP_COMMANDS: readonly string[] = Object.freeze(Object.keys(COMMAND_HELP));

/** `falatrace help`: banner and pitch first, then one line per task, grouped. */
export const mainHelp = (version: string): string => `FalaTrace ${version} (Linux, experimental)
Notas de reunião locais: você anota, o FalaTrace completa com o que foi dito, e cada linha leva ao momento da gravação.

Uso: falatrace <comando> [opções]     Detalhes de um comando: falatrace help <comando>
Primeiro uso: falatrace init → falatrace config → falatrace record doctor (ou abra o FalaTrace Studio).
Confira o consentimento e os provedores antes de gravar. A configuração recording-cli existente continua valendo.

Gravar
  record start | stop | status   Começa, encerra (e enfileira) e mostra a gravação
  record doctor                  Confere os gravadores sem gravar
  record recover | reset         Finaliza uma captura interrompida / limpa o estado
  record check <arquivo>         Confere faixas de áudio e silêncio
  live show <sessão> [--follow]  Transcrição ao vivo da captura
  calls pause | resume           Suspende / retoma as gravações automáticas futuras
                                 (record stop encerra a captura em andamento)

Processar
  transcribe <arquivo>           Cria e inicia um processamento
  jobs list | status <id>        Processamentos locais
  jobs process | retry <id>      Processa ou repete um processamento
  jobs sync                      Envia pendentes, busca resultados e aplica a retenção de mídia
  jobs cleanup --dry-run         Prévia da limpeza do trabalho local concluído
  processing-status              Fila e motivos de espera (JSON)
  diarization queue|status|name  Identifica e nomeia os falantes
  speakers suggest|queue|status  Sugere nomes para os falantes
  subtitles queue | create <id>  Legendas alinhadas

Notas e resumos
  notes show | edit | path <id>  Notas da reunião (edit lê o texto da entrada padrão)
  templates list|show|init|delete  Modelos de resumo
  summary-review show|plan|run   Refaz o resumo a partir da transcrição revisada
  review show | apply | undo     Revisão humana da transcrição (JSON)
  export preview | save          Exporta a transcrição (json, markdown, srt, vtt)

Perguntar
  ask [--meeting <id>] <pergunta>  Pergunta às reuniões, com citações (--yes para destinos externos)
  recipes list | show | run      Receitas prontas: follow-up, riscos, ata...
  library refresh | search       Índice local da biblioteca
  context search <consulta>      Busca reuniões (JSON, para agentes)
  context meeting <job-id>       Contexto limitado de uma reunião (JSON)
  context build | list | show    Memória derivada por cliente
  agent-context capabilities     Contexto local para agentes (MCP: agent-context serve)

Pessoas e ações
  people list|show|rename|merge|alias|hide
  clients list|show|add|rename|delete|assign
  actions list | done | reopen | dismiss
  time list|show|start|stop|add|edit|delete  Horas trabalhadas

Compartilhar
  share <job-id> --to <destino>  Clipboard, Obsidian, Notion, Slack ou app de IA (--dry-run mostra antes)

Configurar
  init | config                  Cria a configuração / mostra o caminho
  keys status | set | remove | test  Chaves de API (os valores nunca são mostrados)
  models list | download | ollama-pull | voice-download
  assistant status|detect|models|login-chatgpt|logout-chatgpt
  google connect | status | disconnect
  voices list | delete           Vozes conhecidas (só assinaturas, nunca áudio)

Serviços
  calls run|status|inspect|install-service|uninstall-service
  reminders status|test|install-service|uninstall-service
  tray run | install-service | uninstall-service
  jobs install-timer | uninstall-timer
  worker run | once | install    Worker remoto (remote check confere o host)
  archive status|add|backfill|sync|restore|install-timer|uninstall-timer
  backup proton|sync|status|install-timer|uninstall-timer
  media status | retention | remove  Retenção da mídia (a transcrição fica)

Avançado/legado
  tui                            Navega gravações e horas no terminal
  studio open <link>             Abre um link falatrace:// no Studio
  calls validate | validation-report | network-probe
  removal-plan show | validate   Plano de remoção (somente prévia)
  desktop bridge | playback      Interno do Studio
  notify ready | reminder        Interno: notificações com botões
  reminders run | live run       Interno: laços dos serviços
  upload | upload-all | s3 play | monitors  Legado
  help [comando] | --version
`;
