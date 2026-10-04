// Progressive enhancement for the static landing: copy buttons only.
// No network requests, storage or tracking. Without JavaScript the buttons stay hidden.
(() => {
  if (!navigator.clipboard || !window.isSecureContext) return;
  for (const button of document.querySelectorAll("[data-copy-target]")) {
    const source = document.getElementById(button.dataset.copyTarget);
    const status = document.getElementById(button.dataset.copyStatus);
    if (!source || !status) continue;
    // Comment lines are dropped: zsh does not accept pasted "#" lines by default.
    const commands = source.textContent
      .split("\n")
      .filter((line) => line.trim() && !line.trim().startsWith("#"))
      .join("\n");
    let timer;
    button.hidden = false;
    button.addEventListener("click", async () => {
      clearTimeout(timer);
      try {
        await navigator.clipboard.writeText(`${commands}\n`);
        status.textContent = button.dataset.copied;
      } catch {
        status.textContent = button.dataset.failed;
      }
      timer = setTimeout(() => { status.textContent = ""; }, 3000);
    });
  }
})();
