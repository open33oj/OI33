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

addPage(new NamedPage(['oi33_ai_summary'], () => {
    const form = document.getElementById('ai-summary-form') as HTMLFormElement;
    if (!form) return;

    const loadingDiv = document.getElementById('ai33-loading')!;
    const loadingText = document.getElementById('ai33-loading-text')!;
    const errorDiv = document.getElementById('ai33-error')!;
    const streamView = document.getElementById('ai33-stream-view')!;

    function setButtonsDisabled(disabled: boolean) {
        form.querySelectorAll('button').forEach((b) => { b.disabled = disabled; });
    }

    function setStatus(text: string) {
        loadingText.textContent = text;
        loadingDiv.style.display = 'block';
    }

    function errorText(err: any): string {
        if (typeof err === 'string') return err;
        if (err?.name === 'ForbiddenError') return '没有权限执行此操作。';
        return err?.name || '请求失败，请重试。';
    }

    form.addEventListener('submit', (ev) => {
        // Progressive enhancement: stream over WebSocket when JS is on,
        // otherwise the plain form POST still works.
        ev.preventDefault();
        const action = (document.getElementById('ai-summary-action') as HTMLInputElement)?.value;
        const domainId = (form.querySelector('input[name="domainId"]') as HTMLInputElement)?.value || 'system';
        const pid = (form.querySelector('input[name="pid"]') as HTMLInputElement)?.value;
        if (!action || !pid) return;

        setButtonsDisabled(true);
        errorDiv.style.display = 'none';
        streamView.style.display = 'none';
        streamView.innerHTML = '';
        setStatus('已连接，正在验证...');

        const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
        const ws = new WebSocket(
            `${protocol}//${location.host}/oi33/ai/summary-stream?domainId=${encodeURIComponent(domainId)}&pid=${encodeURIComponent(pid)}&action=${encodeURIComponent(action)}`,
        );

        let fullText = '';
        let reasoningText = '';
        let reasoningBody: HTMLElement | null = null;

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
            loadingDiv.parentNode!.insertBefore(details, loadingDiv);
            reasoningBody = body;
            return body;
        }

        function fail(err: any) {
            errorDiv.textContent = errorText(err);
            errorDiv.style.display = 'block';
            loadingDiv.style.display = 'none';
            setButtonsDisabled(false);
        }

        ws.onmessage = (event) => {
            const msg = JSON.parse(event.data);
            if (msg.error) {
                fail(msg.error);
                ws.close();
                return;
            }
            if (msg.status === 'generating') {
                setStatus('正在生成精简题意与难度...');
                return;
            }
            if (msg.status === 'difficulty') {
                setStatus('正在评判 AI 参考难度...');
                return;
            }
            if (msg.rchunk) {
                reasoningText += msg.rchunk;
                const body = ensureReasoningBody();
                body.textContent = reasoningText;
                body.scrollTop = body.scrollHeight;
                return;
            }
            if (msg.chunk) {
                fullText += msg.chunk;
                streamView.style.display = 'block';
                // The combined generation ends with a [[难度]]N marker line;
                // never show it in the live preview.
                streamView.innerHTML = renderMarkdown(fullText.split('[[难度]]')[0]);
                typesetMath(streamView);
                return;
            }
            if (msg.done) {
                setStatus('已保存，正在刷新页面...');
                document.getElementById('ai33-reasoning')?.removeAttribute('open');
                ws.close();
                // Reload so the saved summary and difficulty badges render
                // server-side (badge macros are template-side).
                setTimeout(() => window.location.reload(), 1000);
            }
        };

        ws.onerror = () => fail('连接失败，请重试');
    });
}));
