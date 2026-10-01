# FalaTrace — Studio visual real, revisão do alpha.2

Escopo do alpha.2: incremento de Studio, onboarding e pipeline visual, revisado inicialmente em cópia isolada. Alpha.1 e WIP original preservados. Os resultados abaixo são offline/sintéticos; não validam modelos reais ou captura nativa.

## O que agora é funcional

O botão normal do Studio está ligado ao caminho de produção: verificar modelos locais → solicitar preview → consentir → adapter visual Ollama → resumo Ollama → resultado na UI e referência temporal. Não existe texto roteirizado de observação nesse caminho. Ele exige nomes de modelos escolhidos explicitamente e capabilities `vision`/`completion` observadas na resposta de metadados. A configuração existente fornece somente o endpoint, que deve ser loopback sem credenciais/query; modelos selecionados não são salvos em config. Sem modelo/capability comprovados, recusa a análise. Não confirmei a existência ou qualidade de modelos instalados na máquina.

Os testes substituem o transporte HTTP; a biblioteca Qt é sintética. O dispatcher das operações visuais, coordenador, extração, adapter Ollama, validação de observações, chunking e formatação de resumo são os módulos reais. Portanto: o código de produção está conectado, mas nenhum modelo real foi executado. As respostas presentes nas telas são fornecidas pelo transporte fixture, identificadas como tal, e não comprovam interpretação/qualidade de IA. O antigo `MockFrameReview` fica separado e só é selecionado pelo flag explícito de demonstração; na execução normal esse flag está ausente.

## Consentimento e dados

1. Verificar modelos consulta apenas `/api/show`, sem mídia/transcrição. Localidade, capabilities e fingerprint dos metadados são conferidos; modelos cloud/unknown, endpoint externo e credenciais são recusados.
2. Preview verifica SHA da mídia, obtém duração pelo probe, liga horário a IDs reais de segmentos, extrai JPEG limitado e remove scratch. Não chama inferência. A UI mostra endpoint, modelos, timestamp, pergunta, hashes de mídia/transcrição/frame, tamanho e saldo no momento do preview.
3. Autorizar é ação separada. O hash de consentimento vincula endpoint, modelos, plano, origem, frame, pergunta, dados de resumo, fingerprints observados e vencimento de cinco minutos. Provider/origem/modelo alterado ou consentimento ausente/obsoleto recusa o pedido.
4. A visão recebe um JPEG, pergunta e metadata temporal; o resumo recebe transcrição + observações verificadas, em até oito chunks. Não são enviados contexto pessoal extra, config/credenciais ou gravação completa. Apenas providers locais loopback são oferecidos neste fluxo.
5. Observações devem corresponder exatamente a frame/hash/timestamp extraídos. Imagens, perguntas e texto continuam dados não confiáveis nos prompts existentes. O resumo marca revisão necessária; uma imagem não comprova continuidade, fala, decisões ou responsáveis.

Fingerprint de `/api/show` identifica metadados observados, não é atestação criptográfica dos pesos/modelo servidor. Esse limite permanece explícito.

## Persistência, custo e cancelamento

A raiz do Studio é derivada do estado da instalação/usuário e não é campo do payload da UI. O mesmo root contém o contador comum, sessões, checkpoints e resultados privados. Ancestrais symlink, arquivos inseguros e estado inválido são recusados. Arquivos publicados atomicamente em modo 0600; diretórios novos 0700. Não foram criadas/alteradas configurações privadas reais.

Guarda comum neste recorte: **24 tentativas de inferência e 16 previews durante a vida do root**, limites explícitos constantes, sem reset/refund na UI. Studio e pipeline com evidência visual usam o mesmo contador. Reserva é persistida antes da inferência; falha/cancelamento consome a tentativa. A primeira inferência trava identidade de provider/modelos/origem por job; mudar identidade não abre um limite novo. Trocar root de sessão do pipeline não troca o root do contador comum. Um teste inicia processo Bun separado e comprova que a contagem é preservada; identidades diferentes continuam submetidas ao mesmo teto.

O ledger da sessão mantém seu limite adicional: quatro requests, duas rodadas, oito frames e até 8 MiB. Repetir confirmação é idempotente; reabrir após reinício reutiliza os checkpoints sem inferência adicional para o mesmo plano/modelos. O pipeline interno conserva a recusa de plano diferente na mesma rodada. O Studio usa sessão/cache por plano consentido e janela horária, permitindo perguntas diferentes sem mudar a identidade do contador global por job. Fingerprints observados dos modelos continuam vinculados. Clock de teste é propagado ao ledger; após a janela, exige preview/consentimento atuais, sem refund/reset global.

Esses limites são guardas de chamadas da aplicação, **não teto financeiro do provedor, assinatura ou máquina inteira**. Consultas de metadados não são inferências e não entram nesse contador. Pipelines sem evidência visual e outros programas não são contabilizados aqui. O proprietário do filesystem pode editar/remover estado ou mudar ambiente fora da UI; não há alegação de defesa contra esse dono, nem reset automático por TTL. Após esgotar, recusa; nenhuma compra/API paga/fallback é habilitada.

Fechar/cancelar aborta a operação pendente e descarta resposta tardia na UI. Dados já consumidos pelo provider não podem ser revogados. Falha/cancelamento durante inferência não publica resumo nos testes. Um review já concluído e gravado é preservado; Cancelar não é exclusão desse artefato. Resultados/checkpoints privados são derivados, não substituem transcrição/resumo original do job.

Vencimento visual impede reutilização da evidência expirada; notas históricas persistidas continuam legíveis, marcadas como evidência expirada e exigindo revisão. Nova análise usa consentimento fresco; não há novo scheduler de exclusão neste incremento. O mecanismo existente de limpeza de sessões remove frames derivados conhecidos e conserva ledger/budget, mas precisa ser acionado; resultados/notas persistidas não têm exclusão automática prometida. Retenção/remoção completa continua no roadmap, sem apagar dados reais nesta fase.

## Resultado e origem na interface

O resultado real do adapter atualiza imediatamente a aba Resumo; a leitura posterior do detalhe pode recuperar o review persistido, se fonte/transcrição/hash continuam compatíveis; evidência expirada é explicitamente marcada sem ocultar as notas. O resumo original permanece intacto. A ação Ir à origem preserva o instante solicitado em milissegundos; sem player pronto, informa o instante e o limite de playback. A UI normal mostra análise local, enquanto a demonstração mostra mock explicitamente. Modelos/capabilities não são inferidos de um nome ou assinatura.

Corrigido também o bootstrap assíncrono: quando o backend fica disponível após carregar a janela, a UI consulta capabilities. O modal é rolável em 900×640, com Cancelar fixo e resultados/erros em plain text. Screenshots de resultado mostram conteúdo real renderizado pelo Qt; a imagem não é artwork.

## Jornada → critério → teste → resultado

| Jornada | Critério e prova | Resultado |
|---|---|---|
| Sem modelo | Sem capability, não preparar inferência; modelo ausente/unknown recusado | Módulo + Qt aprovados |
| Seleção | Endpoint local, modelos explícitos, capabilities observadas | Dispatcher/coordenador reais; HTTP stub |
| Preview | Hash/probe/timestamp/segmento/frame limitados; zero inferência | Extração FFmpeg real de vídeo sintético + Qt |
| Consentimento | Obrigatório, hash exato e TTL; provider/model/origem alterados recusados | Testes zero chamadas de visão/resumo nos recusados |
| Confirmação | UI chama dispatcher → adapter → resumo; double confirm não duplica | Uma visão e um resumo via transporte stub |
| Evidência inválida | Hash/tempo de observação não correspondentes recusados | Teste invalidframe; resumo não executado |
| Falha/cancelamento | Tentativa consumida; cancelar in-flight não publica resumo | Testes de visão falha, resumo HTTP 500 e abort |
| Persistência | Nova instância reutiliza cache; processo separado preserva contador | Testes reais de filesystem/subprocesso local |
| Guarda comum | Jobs/modelos novos não reiniciam teto; troca de identidade no job recusada | Limite 24 e trava por job testados |
| UI resultado | Conteúdo vem do adapter, atualiza detalhe/resumo, não de mock | Qt real com módulos de produção e transporte fixture |
| Origem | Timestamp 00:01.200 preservado | Qt; playback físico não validado |
| Compacto | Sem overflow horizontal; Cancelar visível | Qt 900×640, inspeção dos pixels |
| Onboarding | Save explícito; cancel/invalid não escreve, unknown/backup preservados | Jornadas anteriores repetidas na rodada atual |

## QA e proteção

- Suíte completa offline: **362 testes, zero falhas, 1.657 assertions, 61 arquivos, 54,11s**. HOME/XDG temporários, comandos de captura/serviços/remotos bloqueados e transporte de modelos stubado.
- Regressões após os findings independentes do Opus: **7 testes, zero falhas, 187 assertions, 5,53s**.
- Qt offscreen: **18 telas, 43 verificações aprovadas**. Receipt vincula hashes finais de QML, coordenador, budget e bridge. Nenhum erro de binding/TypeError/ReferenceError observado na rodada final.
- Tipos CLI/desktop e build CLI aprovados; 291 módulos, 1,17 MB. SDK/dependências existentes; nenhuma instalação de modelo/serviço novo.
- **161 hashes originais e 221 hashes do alpha preservados**, alpha git limpo; branch local sem remoto. Diff whitespace e `git apply --check` contra o alpha passaram, sem aplicar nele.
- Sem captura real, microfone/tela pessoal, mídia privada, chamada efetiva de provider, credencial nova, API paga, push ou publicação.

Continuam não validados: modelos/capabilities reais instalados, qualidade semântica, captura nativa, playback/seek físico, teclado físico/toque/Orca, instalação nativa fria e binários distribuídos. Inputs Qt são instrumentação por timer, não certificação de acessibilidade. Nenhuma alegação de prontidão do produto inteiro.

## Entrega para revisão

Patch cumulativo em relação ao alpha: 16 arquivos, 926 inserções/37 remoções, 117861 bytes. SHA-256: `37a3741352768504ee677bd28652a2e7e0de5d40c63541ffad7598eeeff1d5dc`.

O pacote inclui somente este review, patch/checksum, receipt e quatro screenshots sintéticas (preview, resultado, resumo e compacto). Exclui configs privadas, vídeo/áudio gerados, dependências, SDK, executáveis, histórico e credenciais. O incremento está concluído para revisão do alpha.2; qualquer publicação futura exige decisão separada.


## Revisão independente Opus

Opus 5.5 efetivo revisou o diff inicial imutável, com tools/MCP desativados e fonte/fixtures sanitizados. Nenhum P0 apontado. Dois P1 comprovados foram corrigidos: isolamento de estado no teste direto do pipeline e bloqueio do Studio no primeiro plano/TTL. Regressões validam perguntas distintas, nova autorização após TTL, notas históricas e contador global preservado. O terceiro finding era condicionado a worker com `options.visual`; os workers atuais não passam essa opção. Política escolhida: esgotamento/conflito falha explicitamente sem nova chamada nem sobrescrita do resumo; isso foi testado. O conflito de identidades entre superfícies do contrato opcional permanece limitação para integração futura, não corrigida por bypass/fallback. Opus não fez uma segunda rodada: resolução foi verificada por testes offline locais. Ver FalaTrace-Opus-Review-Resolution.md.
