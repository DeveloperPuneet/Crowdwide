(() => {
  const detectLanguage = (source) => {
    const code = source.trim();
    if (!code) return null;
    if (/^(?:interface\s+\w+|type\s+\w+\s*=)|:\s*(?:string|number|boolean)\b/m.test(code)) return 'typescript';
    if (/<[A-Z][A-Za-z0-9]*(?:\s|>)[\s\S]*\/>/.test(code)) return 'jsx';
    if (/^(?:<!doctype\s+html|<[a-z][\s\S]*>)/i.test(code)) return 'markup';
    if (/^(?:\{[\s\S]*\}|\[[\s\S]*\])$/.test(code)) {
      try {
        JSON.parse(code);
        return 'json';
      } catch {}
    }
    if (/^(?:select|insert|update|delete|create|alter|with)\b/i.test(code)) return 'sql';
    if (/^(?:from\s+\w+\s+import|import\s+\w+|def\s+\w+\s*\(|class\s+\w+.*:|print\s*\()/m.test(code)) return 'python';
    if (/^(?:#!\/.*\b(?:ba)?sh\b|\$\s|(?:npm|npx|git|cd|sudo|docker)\s)/m.test(code)) return 'bash';
    if (/^(?:const|let|var|function|async\s+function|export\s|import\s)|=>|console\.(?:log|error)\s*\(/m.test(code)) return 'javascript';
    if (/^[.#@][\w-]+(?:\s*,\s*[.#@][\w-]+)*\s*\{[\s\S]*:[^}]+}/.test(code)) return 'css';
    return null;
  };

  const blocks = document.querySelectorAll('.code-block code');
  blocks.forEach((code) => {
    const language = Array.from(code.classList).find((name) => name.startsWith('language-'))?.slice(9) || detectLanguage(code.textContent);
    if (language && !code.classList.contains(`language-${language}`)) code.classList.add(`language-${language}`);
    const label = code.closest('.code-block')?.querySelector('[data-code-language-label]');
    if (label && label.textContent === 'Auto-detect' && language) label.textContent = `${language} · detected`;
    if (window.Prism && language) window.Prism.highlightElement(code);
  });

  document.addEventListener('click', async (event) => {
    if (!(event.target instanceof Element)) return;
    const button = event.target.closest('[data-copy-code]');
    if (!button) return;
    const block = button.closest('.code-block');
    const code = block?.querySelector('code');
    const status = block?.querySelector('[data-copy-status]');
    if (!code || !status) return;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(code.textContent);
      } else {
        const temporary = document.createElement('textarea');
        temporary.value = code.textContent;
        temporary.setAttribute('readonly', '');
        temporary.style.position = 'fixed';
        temporary.style.opacity = '0';
        document.body.append(temporary);
        temporary.select();
        const copied = document.execCommand('copy');
        temporary.remove();
        if (!copied) throw new Error('Clipboard copy command failed.');
      }
      status.textContent = 'Copied';
    } catch {
      status.textContent = 'Copy failed — select the code to copy it.';
    }
  });
})();
