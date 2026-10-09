// Opt-in device diagnostics. No address/name text, network calls or persistent storage.
export function startInputDiagnostics() {
  const panel = document.createElement('details');
  panel.open = true;
  panel.style.cssText = 'position:fixed;top:72px;right:8px;z-index:100000;width:min(350px,calc(100vw - 16px));max-height:38dvh;overflow:auto;background:#fff;color:#111;border:2px solid #c8102e;padding:8px;font:12px/1.4 monospace;box-sizing:border-box;';
  panel.innerHTML = '<summary>Diagnóstico de digitação — recolher/abrir</summary><p>Digite TESTE no controle abaixo e depois em Seu nome. O relatório mostra apenas eventos e quantidade de caracteres.</p><label>Controle simples <input id="diagnosticControl" type="text" placeholder="Digite TESTE" style="display:block;width:100%;box-sizing:border-box;font-size:16px;color:#111;background:white;padding:8px;border:1px solid #555"></label><button type="button">Limpar relatório</button><pre style="white-space:pre-wrap;overflow-wrap:anywhere;margin:8px 0"></pre>';
  document.body.append(panel);
  const output = panel.querySelector('pre');
  const started = performance.now();
  const lines = [];
  function record(line) {
    lines.push(`${((performance.now() - started) / 1000).toFixed(1)}s ${line}`);
    if (lines.length > 25) lines.shift();
    output.textContent = lines.join('\n');
  }
  panel.querySelector('button').onclick = () => { lines.length = 0; output.textContent = ''; };
  const field = el => el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;
  const name = el => el.id || el.tagName.toLowerCase();
  record(`Tela ${innerWidth}x${innerHeight}; diagnóstico iniciado`);
  for (const type of ['focusin', 'focusout', 'compositionstart', 'compositionend', 'beforeinput', 'input', 'change']) {
    document.addEventListener(type, event => {
      const el = event.target;
      if (!field(el)) return;
      // Observe after all synchronous page listeners; do not intercept keyboard events.
      queueMicrotask(() => {
        record(`${name(el)} ${type} ${event.inputType || ''} n=${el.value.length} foco=${document.activeElement === el} cancelado=${event.defaultPrevented} composição=${Boolean(event.isComposing)}`);
        if (type === 'input') {
          const length = el.value.length;
          setTimeout(() => {
            if (el.isConnected && el.value.length !== length) record(`${name(el)} mudou depois do evento: n=${el.value.length}`);
          }, 100);
        }
      });
    }, true);
  }
  let last = performance.now();
  const timer = setInterval(() => {
    const now = performance.now(), delay = now - last - 500;
    last = now;
    if (document.visibilityState === 'visible' && delay > 250) record(`Página demorou ${Math.round(delay)} ms para responder`);
  }, 500);
  addEventListener('pagehide', () => clearInterval(timer), { once: true });
}
