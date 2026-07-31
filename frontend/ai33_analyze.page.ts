import { $, addPage, NamedPage } from '@hydrooj/ui-default';

// Hydro's global KaTeX auto-render listens for vjContentNew and typesets
// $...$ / \(...\) inside .richmedia containers; nudge it after each render.
function typesetMath(element: HTMLElement) {
    ($(element) as any).trigger('vjContentNew');
}

function renderMarkdown(md: string): string {
    const codeBlocks: string[] = [];
    let html = md.replace(/```(\w*)\n?([\s\S]*?)```/g, (_m, lang, code) => {
        const escaped = code
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
        const langClass = lang ? ` class="language-${lang}"` : '';
        codeBlocks.push(`<pre><code${langClass}>${escaped}</code></pre>`);
        return `\x00CODEBLOCK_${codeBlocks.length - 1}\x00`;
    });

    html = html
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');

    html = html.replace(/\x00CODEBLOCK_(\d+)\x00/g, (_m, idx) => codeBlocks[parseInt(idx)]);

    html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
    html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');

    html = html.replace(/((?:^- .+\n?)+)/gm, (block) => {
        const items = block
            .split('\n')
            .filter((line) => line.startsWith('- '))
            .map((line) => '<li>' + line.slice(2) + '</li>')
            .join('');
        return '<ul>' + items + '</ul>';
    });

    html = html.replace(/((?:^\d+\. .+\n?)+)/gm, (block) => {
        const items = block
            .split('\n')
            .filter((line) => /^\d+\. /.test(line))
            .map((line) => '<li>' + line.replace(/^\d+\. /, '') + '</li>')
            .join('');
        return '<ol>' + items + '</ol>';
    });

    const lines = html.split('\n');
    const out: string[] = [];
    let buf: string[] = [];

    function flush() {
        if (buf.length > 0) {
            out.push('<p>' + buf.join('<br>') + '</p>');
            buf = [];
        }
    }

    for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed === '') {
            flush();
            continue;
        }
        if (/^<(h[23]|pre|ul|ol|li|blockquote)/.test(trimmed)) {
            flush();
            out.push(trimmed);
        } else {
            buf.push(trimmed);
        }
    }
    flush();

    return out.join('\n');
}

addPage(new NamedPage(['oi33_ai_analyze'], () => {
    const rid = (window as any)._ai33_rid || '';
    const csrfToken = (window as any)._ai33_csrf || '';
    const isTeacher = (window as any)._ai33_is_teacher === true;
    const directAnalysisEnabled = (window as any)._ai33_direct_enabled !== false;
    const directAnalysisMessage = '直接分析暂时关闭，请稍后再试。';

    // Render existing analysis on page load
    const existingMd = (window as any)._ai33_existing;
    if (existingMd) {
        const resultText = document.getElementById('ai33-result-text');
        if (resultText) {
            resultText.innerHTML = renderMarkdown(existingMd);
            typesetMath(resultText);
        }
    }

    function getCsrfToken(): string {
        const input = document.querySelector<HTMLInputElement>('input[name="csrfToken"]');
        return input ? input.value : csrfToken;
    }

    function ensureResultDiv(): HTMLElement {
        let resultDiv = document.getElementById('ai33-result');
        if (resultDiv) return resultDiv;

        resultDiv = document.createElement('div');
        resultDiv.id = 'ai33-result';
        resultDiv.style.marginBottom = '1.5rem';

        const textDiv = document.createElement('div');
        textDiv.id = 'ai33-result-text';
        textDiv.className = 'ai33-result-box richmedia';
        resultDiv.appendChild(textDiv);

        // Only teachers may re-analyze / clear; students get a one-shot result.
        if (isTeacher) {
            const actionRow = document.createElement('div');
            actionRow.style.cssText = 'margin-top:0.8rem;display:flex;gap:8px;';

            const retryBtn = document.createElement('button');
            retryBtn.id = 'ai33-retry-btn';
            retryBtn.className = 'rounded button';
            retryBtn.textContent = '重新分析';
            retryBtn.disabled = !directAnalysisEnabled;
            if (!directAnalysisEnabled) retryBtn.title = directAnalysisMessage;
            retryBtn.addEventListener('click', analyze);

            const clearBtn = document.createElement('button');
            clearBtn.id = 'ai33-clear-btn';
            clearBtn.className = 'rounded button ai33-btn-danger';
            clearBtn.textContent = '清除分析';
            clearBtn.addEventListener('click', clearAnalysis);

            actionRow.appendChild(retryBtn);
            actionRow.appendChild(clearBtn);
            resultDiv.appendChild(actionRow);
        }

        const loadingDiv = document.getElementById('ai33-loading')!;
        loadingDiv.parentNode!.insertBefore(resultDiv, loadingDiv);
        return resultDiv;
    }

    function getActionRow(): HTMLElement | null {
        const resultDiv = document.getElementById('ai33-result');
        if (!resultDiv) return null;
        return resultDiv.querySelector<HTMLElement>('div:last-child');
    }

    function formatElapsed(seconds: number): string {
        if (seconds < 60) return `${seconds} 秒`;
        const m = Math.floor(seconds / 60);
        const s = seconds % 60;
        return `${m} 分 ${s} 秒`;
    }

    async function analyze() {
        const btn = document.getElementById('ai33-analyze-btn') as HTMLButtonElement;
        const retryBtn = document.getElementById('ai33-retry-btn') as HTMLButtonElement;
        const loadingDiv = document.getElementById('ai33-loading')!;
        const errorDiv = document.getElementById('ai33-error')!;
        const actionsDiv = document.getElementById('ai33-actions')!;

        if (!directAnalysisEnabled) {
            errorDiv.textContent = directAnalysisMessage;
            errorDiv.style.display = 'block';
            return;
        }

        if (btn) btn.disabled = true;
        if (retryBtn) retryBtn.disabled = true;
        actionsDiv.style.display = 'none';
        errorDiv.style.display = 'none';
        loadingDiv.style.display = 'block';

        const resultDiv = ensureResultDiv();
        resultDiv.style.display = 'block';
        const actionRow = getActionRow();
        if (actionRow) actionRow.style.display = 'none';

        const resultText = document.getElementById('ai33-result-text')!;
        resultText.innerHTML = '';

        const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
        const ws = new WebSocket(`${protocol}//${location.host}/oi33/ai/analyze-stream/${rid}`);

        let fullText = '';
        let reasoningText = '';
        let reasoningBody: HTMLElement | null = null;
        let elapsedTimer: ReturnType<typeof setInterval> | null = null;
        let startTime = 0;

        function ensureReasoningBody(): HTMLElement {
            if (reasoningBody) return reasoningBody;
            document.getElementById('ai33-reasoning')?.remove();
            const details = document.createElement('details');
            details.id = 'ai33-reasoning';
            details.open = true;
            details.style.marginBottom = '0.8rem';
            const summaryEl = document.createElement('summary');
            summaryEl.textContent = 'AI 思考过程';
            summaryEl.style.cssText = 'cursor:pointer;color:#888;font-size:0.9em;';
            const body = document.createElement('div');
            body.style.cssText = 'white-space:pre-wrap;color:#888;font-size:0.85em;max-height:240px;overflow-y:auto;margin-top:0.4rem;';
            details.append(summaryEl, body);
            resultText.parentElement!.insertBefore(details, resultText);
            reasoningBody = body;
            return body;
        }

        function setStatus(text: string) {
            loadingDiv.innerHTML = `<span class="ai33-spinner"></span> ${text}`;
        }

        function startTimer() {
            startTime = Date.now();
            elapsedTimer = setInterval(() => {
                const elapsed = Math.floor((Date.now() - startTime) / 1000);
                loadingDiv.innerHTML = `<span class="ai33-spinner"></span> ${formatElapsed(elapsed)}`;
            }, 1000);
        }

        function stopTimer() {
            if (elapsedTimer) {
                clearInterval(elapsedTimer);
                elapsedTimer = null;
            }
        }

        ws.onopen = () => {
            setStatus('已连接，正在验证...');
        };

        ws.onmessage = (event) => {
            const msg = JSON.parse(event.data);
            if (msg.error) {
                stopTimer();
                errorDiv.textContent = msg.error;
                errorDiv.style.display = 'block';
                actionsDiv.style.display = '';
                if (btn) btn.disabled = false;
                if (retryBtn) retryBtn.disabled = false;
                loadingDiv.style.display = 'none';
                if (actionRow) actionRow.style.display = '';
                return;
            }
            if (msg.status === 'summarizing') {
                setStatus('首次分析本题，正在生成精简题意...');
                return;
            }
            if (msg.status === 'queued') {
                setStatus(msg.position > 1 ? `排队中，您前面还有 ${msg.position - 1} 人...` : '排队中，下一位就是您...');
                return;
            }
            if (msg.status === 'analyzing') {
                setStatus('正在调用 AI，请耐心等待...');
                startTimer();
                return;
            }
            if (msg.rchunk) {
                if (elapsedTimer) {
                    stopTimer();
                    setStatus('AI 正在思考...');
                }
                reasoningText += msg.rchunk;
                const body = ensureReasoningBody();
                body.textContent = reasoningText;
                body.scrollTop = body.scrollHeight;
                return;
            }
            if (msg.chunk) {
                if (elapsedTimer && fullText === '') {
                    // First chunk arrived, switch to streaming indicator
                    stopTimer();
                    setStatus('正在接收 AI 回复...');
                }
                fullText += msg.chunk;
                resultText.innerHTML = renderMarkdown(fullText);
                typesetMath(resultText);
            }
            if (msg.status === 'saving') {
                setStatus('正在保存结果...');
            }
            if (msg.done) {
                stopTimer();
                const totalSec = Math.floor((Date.now() - startTime) / 1000);
                resultText.innerHTML = renderMarkdown(msg.fullText);
                typesetMath(resultText);
                document.getElementById('ai33-reasoning')?.removeAttribute('open');
                if (msg.balanceText) {
                    const balanceEl = document.getElementById('ai33-balance');
                    if (balanceEl) balanceEl.textContent = msg.balanceText;
                }
                loadingDiv.innerHTML = `分析完成，耗时 ${formatElapsed(totalSec)}${msg.costText ? `，${msg.costText}` : ''}`;
                if (actionRow) actionRow.style.display = '';
                (window as any)._ai33_existing = msg.fullText;
                ws.close();
            }
        };

        ws.onerror = () => {
            stopTimer();
            errorDiv.textContent = '连接失败，请重试';
            errorDiv.style.display = 'block';
            actionsDiv.style.display = '';
            if (btn) btn.disabled = false;
            if (retryBtn) retryBtn.disabled = false;
            loadingDiv.style.display = 'none';
            if (actionRow) actionRow.style.display = '';
        };

        ws.onclose = () => {
            stopTimer();
        };
    }

    async function clearAnalysis() {
        if (!rid) return;
        const errorDiv = document.getElementById('ai33-error')!;
        errorDiv.style.display = 'none';
        try {
            const resp = await fetch(`/oi33/ai/analysis/${rid}/delete`, {
                method: 'POST',
                headers: { 'X-CSRF-Token': getCsrfToken() },
            });
            if (resp.ok) {
                window.location.reload();
            } else {
                const json = await resp.json().catch(() => ({}));
                const err = json?.error;
                errorDiv.textContent = (typeof err === 'string' ? err : err?.message || err?.name) || '清空失败';
                errorDiv.style.display = 'block';
            }
        } catch (e: any) {
            errorDiv.textContent = '清空失败：' + (e.message || '未知错误');
            errorDiv.style.display = 'block';
        }
    }

    document.getElementById('ai33-analyze-btn')?.addEventListener('click', analyze);
    document.getElementById('ai33-retry-btn')?.addEventListener('click', analyze);
    document.getElementById('ai33-clear-btn')?.addEventListener('click', clearAnalysis);
}));

addPage(new NamedPage(['record_detail'], () => {
    const rid = window.location.pathname.split('/').pop() || '';
    if (!rid) return;

    // Find the download button's toolbar (section__tools in the code section header)
    const tools = document.querySelector('a[href="?download=true"]')?.parentElement;
    if (!tools) return;

    const btn = document.createElement('a');
    btn.className = 'primary rounded button';
    btn.href = `/oi33/ai/analyze/${rid}`;
    btn.textContent = 'AI 刷题建议';
    tools.appendChild(btn);
}));
