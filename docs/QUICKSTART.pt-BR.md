# Início rápido

Do código-fonte até a primeira gravação processada. O FalaTrace é uma versão alpha experimental para Linux: confira os provedores e destinos antes de gravar algo real e grave só com a permissão das pessoas envolvidas. [English](QUICKSTART.md)

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

Abra o **FalaTrace Studio** pelo menu de aplicativos ou rode `recording-studio`. Sem configuração, o Studio abre o assistente. Nada é salvo nem instalado até você clicar em **Concluir**, inclusive a chave da OpenAI. O teste de áudio e os downloads de modelos só rodam pelos próprios botões.

1. **Boas-vindas.** Escolha o idioma (automático, português ou inglês) e confirme que vai gravar só com permissão. **Usar os padrões recomendados** vai direto para a revisão com só áudio, processamento local e gravação automática desligada.
2. **Captura.** Escolha **Só áudio** (recomendado) ou **Tela e áudio**, e depois o microfone e o áudio do sistema. **Testar áudio** grava 5 segundos, mostra o nível de cada faixa e apaga o arquivo.
3. **Processamento.** Escolha onde transcrever e resumir: tudo neste computador, transcrição local com resumo pela OpenAI, ou tudo pela OpenAI. O assistente mostra o que falta, oferece baixar o modelo recomendado do Whisper ou o modelo do Ollama e pede a chave da OpenAI quando ela é necessária. Os downloads só começam pelos próprios botões.
4. **Gravação automática.** Deixe desligada, só avise quando uma chamada começar ou grave sozinho as chamadas detectadas.
5. **Revisão.** Confira o resumo e escolha quais serviços iniciar agora: o monitor de chamadas, o processamento em segundo plano e o indicador na bandeja.

Dá para mudar tudo depois em **Configurações**. A lista completa de opções está na [referência de configuração](CONFIGURATION.md) (em inglês).

## 3. Gravar e processar

- **Gravar…** no topo inicia uma gravação manual depois de uma confirmação; **Parar captura** encerra. Com a gravação automática ligada, as chamadas detectadas começam e terminam sozinhas.
- As gravações novas aparecem na biblioteca. Com o processamento automático ligado, elas são transcritas e resumidas em segundo plano.
- Se não, abra a gravação e clique em **Processar…**. A janela mostra para onde vão o áudio e a transcrição, marca o que sai do computador e pede consentimento antes de enfileirar.
- Com os avisos ligados, uma notificação aparece quando o processamento termina ou falha.

## 4. Revisar e usar os resultados

- As abas **Transcrição**, **Resumo** e **Falantes** mostram os resultados com atalhos para o trecho original. Correções viram revisões humanas; o original é preservado.
- **Exportar** grava arquivos JSON, Markdown, SRT ou WebVTT neste computador.
- **Acesso para IA…** autoriza um assistente local a ler esta gravação. Depois, **Conectar meu assistente…** mostra o comando para o Claude Code, o Codex ou o Gemini CLI. Você copia e roda no seu terminal; pausar ou revogar vale na próxima consulta.

## 5. Quando algo não funciona

- **Configurações → Serviços e diagnóstico → Verificar agora** confere o FFmpeg, o Whisper.cpp e o modelo, o Ollama e o modelo, as chaves de API e o backend de gravação, sem gravar nem contatar serviços externos. Cada problema leva à seção que resolve.
- **Configurações → Chaves de API → Testar chave** pergunta ao provedor se a chave é aceita, sem enviar áudio nem texto.
- Pelo terminal:

  ```sh
  falatrace record doctor
  falatrace keys status
  journalctl --user -u recording-cli-calls -n 50
  ```

## Desinstalar

```sh
make uninstall-studio
make uninstall
```

Os dois removem só os programas instalados. A configuração, as chaves, as gravações e os backups continuam onde estão.
