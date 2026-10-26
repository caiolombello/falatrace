# Início rápido

Do código-fonte até as primeiras notas de reunião. O FalaTrace é uma versão alpha experimental para Linux: confira os provedores e destinos antes de gravar algo real e grave só com a permissão das pessoas envolvidas. [English](QUICKSTART.md)

## 1. Instalar

Você precisa do Bun 1.4, do FFmpeg e do Git. O Studio também precisa do Qt 6.10 com o MpvQt; o sistema testado é o Ubuntu 26.04. O processamento local precisa do [whisper.cpp](https://github.com/ggml-org/whisper.cpp) (`whisper-cli`) e do [Ollama](https://ollama.com), instalados à parte.

```sh
git clone https://github.com/caiolombello/falatrace.git && cd falatrace
bun install --frozen-lockfile --ignore-scripts
make install-cli
```

Para instalar o Studio com atalho no menu, instale os cabeçalhos do Qt da sua distribuição e rode `make install-studio`:

```sh
sudo apt install qt6-base-dev qt6-base-dev-tools qt6-declarative-dev libmpvqt-dev
make install-studio
```

O `make install-studio` compila o Studio, instala em `~/.local/share/falatrace/studio` e cria o comando `recording-studio`, o atalho no menu e o ícone. Ele não usa sudo nem baixa nada. Sem os pacotes do Qt, `bun run desktop:setup` baixa os cabeçalhos para um cache do usuário.

## 2. Primeiro uso

Abra o **FalaTrace Studio** pelo menu de aplicativos ou rode `recording-studio`. Sem configuração, o Studio abre o assistente. Nada é salvo nem instalado até você concluir, inclusive a chave da OpenAI. O teste de áudio e os downloads de modelos só rodam pelos próprios botões.

1. **Boas-vindas.** Escolha o idioma (automático, português ou inglês) e confirme que vai gravar só com permissão. **Começar rápido (recomendado)** vai direto para a revisão com só áudio, processamento local, notas geradas assim que a gravação para e gravação automática desligada.
2. **Captura.** Escolha **Só áudio** (recomendado) ou **Tela e áudio**, e depois o microfone e o áudio do sistema. **Testar áudio** grava 5 segundos, mostra o nível de cada faixa e apaga o arquivo.
3. **Processamento.** Escolha onde transcrever e gerar as notas: tudo neste computador, transcrição local com resumo pela OpenAI, ou tudo pela OpenAI. O assistente mostra o que falta, oferece baixar o modelo recomendado do Whisper e o modelo do Ollama (**Baixar o que falta** começa os dois, com o tamanho e uma estimativa de tempo) e pede a chave da OpenAI quando ela é necessária. Os downloads só começam pelos próprios botões e continuam enquanto você passa pelas outras etapas.
4. **Gravação automática.** Deixe desligada, só avise quando uma chamada começar ou grave sozinho as chamadas detectadas.
5. **Revisão.** Confira o resumo e escolha quais serviços iniciar agora: o monitor de chamadas, o processamento em segundo plano e o indicador na bandeja. Depois, conclua. Se um modelo ainda está baixando, concluir espera por ele; **Concluir sozinho quando o download terminar** salva a configuração assim que ele acabar.
6. **Pronto.** Veja o que foi configurado e o que ainda falta. Em seguida, **Gravar 1 minuto de teste**: depois de confirmar, digite algumas notas enquanto grava. A gravação para sozinha depois de um minuto e abre a reunião; com o início rápido, suas primeiras notas aparecem ali alguns minutos depois, processadas neste computador.

Dá para mudar tudo depois em **Configurações**. A lista completa de opções está na [referência de configuração](CONFIGURATION.md) (em inglês).

## 3. Gravar e anotar

- Inicie uma gravação manual pelo Studio depois de uma confirmação e pare quando a reunião acabar. Com a gravação automática ligada, as chamadas detectadas começam e terminam sozinhas.
- Enquanto grava, digite notas curtas no bloco de notas: uma decisão, um nome, uma tarefa (`[ ] enviar a proposta`). Cada linha guarda o momento em que foi digitada. <!-- studio-check -->
- Quando a gravação para, ela é processada:
  - na hora, quando o processamento é local e `processing.fastPath` está ligado (o início rápido liga);
  - em segundo plano, quando o processamento automático está ligado;
  - se não, quando você abre a gravação e escolhe **Gerar notas…**, que mostra para onde vão o áudio e a transcrição, marca o que sai do computador e pede consentimento antes de enfileirar.
- Uma notificação avisa quando as notas ficam prontas; clicar nela abre a reunião no Studio.

Parar encerra a captura atual; pausar novas gravações vale só para as próximas gravações automáticas. Fechar a janela do Studio mantém rodando os serviços em segundo plano configurados. Nenhum comando de instalação ou de init inicia uma captura.

Pelo terminal: `falatrace record start`, `falatrace record stop` (encerra a captura atual), `falatrace calls pause` (suspende as próximas gravações automáticas), `falatrace calls status` e `printf '%s\n' "- minha nota" | falatrace notes edit <job-id>`.

## 4. Ler e usar as notas

- A reunião abre nas notas: suas linhas como você escreveu, completadas pela IA com o que foi dito. Cada linha da IA cita o momento de onde veio; siga a citação para ouvir esse trecho. Linhas incertas aparecem marcadas. <!-- studio-check -->
- O modelo (1:1, daily, postmortem…) foi escolhido para esta reunião; com o Ollama neste computador, dá para gerar as notas de novo com outro modelo ou idioma sem perder as suas. Veja [notas e modelos](NOTES-AND-TEMPLATES.md) (em inglês).
- As abas **Transcrição** e **Falantes** mostram a fonte. Correções viram revisões humanas; o original é preservado.
- **Pergunte** sobre esta reunião, uma pessoa, um cliente ou a biblioteca inteira; as respostas citam as fontes. O padrão é o Ollama local; qualquer outro provedor mostra para onde vai a pergunta e pede confirmação antes. Veja [assistente](ASSISTANT.md) (em inglês).
- **Compartilhe** as notas no Obsidian, no Notion, no Slack ou num app de IA depois de uma prévia; veja [compartilhamento](SHARING.md) (em inglês). **Exportar** grava arquivos JSON, Markdown, SRT ou WebVTT neste computador.
- **Acesso para agentes…**, na aba **Agentes**, autoriza um agente local (Claude Code, Codex ou Gemini CLI) a ler esta gravação e mostra o comando para conectá-lo. Você copia e roda no seu terminal; pausar ou revogar vale na próxima consulta.

## 5. Acompanhar com o tempo

- **Pessoas, Clientes e Ações** reúnem com quem você se reuniu, a que cliente cada reunião pertence e cada ação combinada, que você pode marcar como feita. Veja [pessoas, clientes e ações](PEOPLE-CLIENTS-ACTIONS.md) (em inglês). <!-- studio-check -->
- **Lembretes** avisam pouco antes de uma reunião da agenda, com o que ficou aberto das reuniões anteriores e um botão para gravar ou pular: `falatrace reminders install-service`. Veja [lembretes e transcrição ao vivo](REMINDERS-AND-LIVE.md) (em inglês).
- As opções de **privacidade e retenção** decidem por quanto tempo a mídia fica guardada. Veja [privacidade e dados](PRIVACY.md) (em inglês).

## 6. Quando algo não funciona

- **Configurações → Serviços e diagnóstico → Verificar agora** confere o FFmpeg, o Whisper.cpp e o modelo, o Ollama e o modelo, as chaves de API e o backend de gravação, sem gravar nem contatar serviços externos. Cada problema leva à seção que resolve.
- **Configurações → Chaves de API → Testar chave** pergunta ao provedor se a chave é aceita, sem enviar áudio nem texto.
- Pelo terminal:

  ```sh
  falatrace record doctor
  falatrace keys status
  falatrace assistant status
  journalctl --user -u recording-cli-calls -n 50
  ```

## Desinstalar

```sh
make uninstall-studio
make uninstall
```

Os dois removem só os programas instalados. A configuração, as chaves, as gravações, as notas e os backups continuam onde estão.
