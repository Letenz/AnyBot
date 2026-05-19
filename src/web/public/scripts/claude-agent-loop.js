(function () {
    var LARGE_MESSAGE_PREVIEW_CHARS = 20000;

    function escapeHtml(value) {
        return String(value || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
    }

    function formatDuration(ms) {
        if (!ms && ms !== 0) return '';
        var seconds = Math.max(0, Math.round(ms / 1000));
        var mins = Math.floor(seconds / 60);
        var secs = seconds % 60;
        return mins > 0 ? mins + 'm ' + secs + 's' : secs + 's';
    }

    function renderMarkdown(text) {
        if (!text) return '';
        try {
            return typeof marked !== 'undefined' ? marked.parse(text) : escapeHtml(text);
        } catch (_) {
            return escapeHtml(text);
        }
    }

    function parseSseChunk(buffer, onEvent) {
        var boundary = buffer.indexOf('\n\n');
        while (boundary !== -1) {
            var raw = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            var eventName = 'message';
            var dataLines = [];
            raw.split('\n').forEach(function (line) {
                if (line.startsWith('event:')) eventName = line.slice(6).trim();
                if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
            });
            if (dataLines.length > 0) {
                try {
                    onEvent(eventName, JSON.parse(dataLines.join('\n')));
                } catch (e) {
                    console.warn('Failed to parse Claude Agent event', e);
                }
            }
            boundary = buffer.indexOf('\n\n');
        }
        return buffer;
    }

    function createMessage(opts) {
        var messagesEl = opts.messagesEl;
        var scrollBottom = opts.scrollBottom || function () {};
        var startedAt = opts.startedAt || Date.now();
        var isPersisted = !!opts.persisted;

        var state = {
            answerText: '',
            processTextSegments: [],
            activeProcessTextSegment: null,
            tools: new Map(),
            readFiles: new Set(),
            searchCount: 0,
            listCount: 0,
            bashCount: 0,
            editCount: 0,
            webCount: 0,
            status: 'running',
            durationMs: Math.max(0, Date.now() - startedAt),
            changeReview: opts.changeReview || null,
            answerIsTruncated: !!opts.contentTruncated,
            answerChars: opts.contentChars || 0,
            fullAnswerLoader: opts.fullContentLoader || null,
        };

        var row = document.createElement('div');
        row.className = 'message-row ai';

        var bubble = document.createElement('div');
        bubble.className = 'bubble';

        var avatar = document.createElement('div');
        avatar.className = 'avatar ai-avatar';
        avatar.textContent = 'Ab';

        var content = document.createElement('div');
        content.className = 'message-content claude-agent-message';

        var process = document.createElement('details');
        process.className = 'claude-process';
        process.open = opts.open !== undefined ? !!opts.open : !isPersisted;

        var processSummary = document.createElement('summary');
        processSummary.className = 'claude-process-summary';
        processSummary.innerHTML =
            '<span class="claude-process-title" data-role="title">处理中 ' + formatDuration(state.durationMs) + '</span>' +
            '<span class="claude-process-chevron">›</span>';

        var processBody = document.createElement('div');
        processBody.className = 'claude-process-body';

        var compactSummary = document.createElement('div');
        compactSummary.className = 'claude-activity-summary';
        compactSummary.style.display = 'none';
        compactSummary.innerHTML =
            '<span class="claude-activity-icon">›_</span>' +
            '<span data-role="activity-summary"></span>';

        var activityList = document.createElement('div');
        activityList.className = 'claude-activity-list';

        processBody.appendChild(compactSummary);
        processBody.appendChild(activityList);
        process.appendChild(processSummary);
        process.appendChild(processBody);

        var finalEl = document.createElement('div');
        finalEl.className = 'claude-final-answer streaming';
        finalEl.innerHTML = isPersisted ? '' :
            '<div class="typing-indicator compact">' +
            '<div class="typing-dot"></div><div class="typing-dot"></div><div class="typing-dot"></div>' +
            '</div>';

        content.appendChild(process);
        content.appendChild(finalEl);
        bubble.appendChild(avatar);
        bubble.appendChild(content);
        row.appendChild(bubble);
        messagesEl.appendChild(row);
        if (window.AnyBotMessageMeta && typeof window.AnyBotMessageMeta.attach === 'function') {
            window.AnyBotMessageMeta.attach(row, {
                createdAt: opts.createdAt || startedAt,
                copyText: function () { return state.answerText || finalEl.textContent || ''; },
            });
        }
        scrollBottom();

        var ticker = isPersisted ? null : setInterval(function () {
            if (state.status !== 'running') {
                clearInterval(ticker);
                return;
            }
            state.durationMs = Date.now() - startedAt;
            updateProcessTitle();
        }, 1000);

        function updateProcessTitle() {
            var title = processSummary.querySelector('[data-role="title"]');
            var duration = formatDuration(state.durationMs || (Date.now() - startedAt));
            title.textContent = (state.status === 'running' ? '处理中 ' : '已处理 ') + duration;
        }

        function updateActivitySummary() {
            var parts = [];
            if (state.readFiles.size > 0) parts.push(state.readFiles.size + ' 个文件');
            if (state.searchCount > 0) parts.push(state.searchCount + ' 次搜索');
            if (state.listCount > 0) parts.push(state.listCount + ' 个列表');
            if (state.webCount > 0) parts.push('已搜索网页 ' + state.webCount + ' 次');
            if (state.bashCount > 0) parts.push('已运行 ' + state.bashCount + ' 条命令');
            if (state.editCount > 0) parts.push('已修改 ' + state.editCount + ' 个文件');

            if (parts.length === 0) {
                compactSummary.style.display = 'none';
                return;
            }

            compactSummary.style.display = 'flex';
            compactSummary.querySelector('[data-role="activity-summary"]').textContent = '已探索 ' + parts.join(',');
        }

        function renderAnswer() {
            finalEl.classList.remove('streaming');
            var answerText = String(state.answerText || '');
            var isLarge = state.answerIsTruncated || answerText.length > LARGE_MESSAGE_PREVIEW_CHARS;
            var visibleText = isLarge
                ? (state.answerIsTruncated ? answerText : answerText.slice(0, LARGE_MESSAGE_PREVIEW_CHARS) + '\n\n...[内容较长，已折叠]')
                : answerText;
            finalEl.innerHTML = renderMarkdown(visibleText);
            finalEl.querySelectorAll('pre code').forEach(function (block) {
                if (typeof hljs !== 'undefined') hljs.highlightElement(block);
            });
            if (isLarge) {
                var expand = document.createElement('button');
                expand.className = 'large-message-expand';
                expand.type = 'button';
                expand.textContent = state.answerChars ? ('展开完整内容（' + state.answerChars + ' 字符）') : '展开完整内容';
                expand.addEventListener('click', async function () {
                    expand.disabled = true;
                    expand.textContent = '加载中...';
                    if (state.answerIsTruncated && state.fullAnswerLoader) {
                        try {
                            state.answerText = await state.fullAnswerLoader();
                            state.answerIsTruncated = false;
                        } catch (_) {
                            expand.disabled = false;
                            expand.textContent = '展开完整内容';
                            return;
                        }
                    }
                    finalEl.innerHTML = renderMarkdown(state.answerText);
                    finalEl.querySelectorAll('pre code').forEach(function (block) {
                        if (typeof hljs !== 'undefined') hljs.highlightElement(block);
                    });
                    renderChangeReview();
                });
                finalEl.appendChild(expand);
            }
            renderChangeReview();
            scrollBottom();
        }

        function renderChangeReview() {
            if (!state.changeReview || !window.ChangeReview) return;
            var existing = content.querySelector('.change-review-card');
            if (existing) existing.remove();
            var reviewCard = window.ChangeReview.render({
                review: state.changeReview,
                scrollBottom: scrollBottom,
            });
            if (reviewCard) content.appendChild(reviewCard);
        }

        function renderProcessTextSegment(segment) {
            if (!segment.text) {
                segment.el.remove();
                return;
            }
            segment.el.innerHTML = renderMarkdown(segment.text);
            segment.el.querySelectorAll('pre code').forEach(function (block) {
                if (typeof hljs !== 'undefined') hljs.highlightElement(block);
            });
            scrollBottom();
        }

        function appendProcessText(text) {
            if (!text) return;
            var segment = state.activeProcessTextSegment;
            if (!segment) {
                var el = document.createElement('div');
                el.className = 'claude-process-text';
                segment = { el: el, text: '' };
                state.processTextSegments.push(segment);
                state.activeProcessTextSegment = segment;
                activityList.appendChild(el);
            }
            segment.text += text;
            renderProcessTextSegment(segment);
        }

        function removeFinalAnswerFromProcessText(finalText) {
            var answerText = String(finalText).trim();
            if (!answerText || state.processTextSegments.length === 0) return;

            var fullText = state.processTextSegments.map(function (segment) {
                return segment.text;
            }).join('');
            var processText = fullText.trimEnd();
            if (!processText.endsWith(answerText)) return;

            var keepText = processText.slice(0, processText.length - answerText.length).trimEnd();
            var keepLength = keepText.length;
            var offset = 0;

            state.processTextSegments.slice().forEach(function (segment) {
                var nextOffset = offset + segment.text.length;
                if (offset >= keepLength) {
                    segment.text = '';
                } else if (nextOffset > keepLength) {
                    segment.text = segment.text.slice(0, keepLength - offset).trimEnd();
                }
                offset = nextOffset;
                renderProcessTextSegment(segment);
            });

            state.processTextSegments = state.processTextSegments.filter(function (segment) {
                return !!segment.text;
            });
            state.activeProcessTextSegment = null;
        }

        function classifyTool(tool) {
            var name = tool.name || 'Tool';
            var summary = tool.summary || '';
            if (name === 'Read') {
                if (summary) state.readFiles.add(summary);
                return 'Read ' + summary;
            }
            if (name === 'Grep') {
                state.searchCount += 1;
                return 'Searched for ' + summary;
            }
            if (name === 'Glob') {
                state.searchCount += 1;
                return 'Searched files ' + summary;
            }
            if (name === 'LS') {
                state.listCount += 1;
                return 'Listed files in ' + (summary || '.');
            }
            if (name === 'Bash') {
                state.bashCount += 1;
                return '已运行 ' + summary;
            }
            if (name === 'Edit' || name === 'MultiEdit' || name === 'Write' || name === 'NotebookEdit') {
                state.editCount += 1;
                if (summary) state.readFiles.add(summary);
                return (name === 'Write' ? 'Wrote ' : 'Edited ') + summary;
            }
            if (name === 'WebSearch' || name === 'WebFetch') {
                state.webCount += 1;
                return (name === 'WebFetch' ? 'Fetched ' : 'Searched web ') + summary;
            }
            return name + (summary ? ' ' + summary : '');
        }

        function ensureTool(tool) {
            var existing = state.tools.get(tool.id);
            if (existing) return existing;

            var lineText = classifyTool(tool);
            var isShell = tool.name === 'Bash';
            var el = document.createElement(isShell ? 'details' : 'div');
            el.className = 'claude-activity-item running' + (isShell ? ' shell' : '');
            el.dataset.toolId = tool.id;

            if (isShell) {
                el.open = false;
                el.innerHTML =
                    '<summary>' +
                    '<span class="claude-activity-text">' + escapeHtml(lineText) + '</span>' +
                    '<span class="claude-activity-chevron">›</span>' +
                    '</summary>' +
                    '<div class="claude-shell-block" data-role="shell"></div>';
            } else {
                el.textContent = lineText;
            }

            activityList.appendChild(el);
            existing = { data: tool, el: el, text: lineText };
            state.tools.set(tool.id, existing);
            updateActivitySummary();
            scrollBottom();
            return existing;
        }

        function renderShell(toolState, event) {
            var shell = toolState.el.querySelector('[data-role="shell"]');
            if (!shell) return;
            var command = toolState.data.summary || '';
            var output = event.output || {};
            var stdout = output.stdout || output.text || '';
            var stderr = output.stderr || '';
            var status = event.status === 'success' ? '成功' : '失败';
            var body = '';
            body += '<div class="claude-shell-title">Shell</div>';
            if (command) body += '<pre><code>$ ' + escapeHtml(command) + '</code></pre>';
            if (stdout) {
                body += '<pre><code>' + escapeHtml(stdout) + '</code></pre>';
            } else if (!stderr && event.status === 'success') {
                body += '<div class="claude-shell-empty">无输出</div>';
            }
            if (stderr) body += '<pre class="stderr"><code>' + escapeHtml(stderr) + '</code></pre>';
            if (event.error) body += '<pre class="stderr"><code>' + escapeHtml(event.error) + '</code></pre>';
            body += '<div class="claude-shell-status">' + (event.status === 'success' ? '✓ ' : '✕ ') + status + '</div>';
            shell.innerHTML = body;
        }

        function renderDiffs(toolState, diffs) {
            if (!diffs || diffs.length === 0) return;
            diffs.forEach(function (entry) {
                var diff = document.createElement('details');
                diff.className = 'claude-inline-diff';
                diff.innerHTML =
                    '<summary>Diff ' + escapeHtml(entry.path) + '</summary>' +
                    '<pre>' + renderDiff(entry.diff) + '</pre>';
                toolState.el.appendChild(diff);
            });
        }

        function renderDiff(diff) {
            return String(diff || '').split('\n').map(function (line) {
                var cls = 'ctx';
                if (line.startsWith('+') && !line.startsWith('+++')) cls = 'add';
                if (line.startsWith('-') && !line.startsWith('---')) cls = 'del';
                if (line.startsWith('@@')) cls = 'hunk';
                return '<span class="' + cls + '">' + escapeHtml(line || ' ') + '</span>';
            }).join('\n');
        }

        function markTool(event) {
            var toolState = state.tools.get(event.toolId);
            if (!toolState) {
                toolState = ensureTool({
                    id: event.toolId,
                    name: 'Tool',
                    summary: '',
                });
            }
            toolState.el.classList.remove('running');
            toolState.el.classList.toggle('failed', event.status !== 'success');
            if (toolState.data.name === 'Bash') renderShell(toolState, event);
            if (event.error && toolState.data.name !== 'Bash') {
                var err = document.createElement('div');
                err.className = 'claude-activity-error';
                err.textContent = event.error;
                toolState.el.appendChild(err);
            }
            renderDiffs(toolState, event.diffs);
        }

        function handleEvent(event) {
            if (!event || !event.type) return;
            if (event.type === 'agent_status') {
                if (event.durationMs || event.durationMs === 0) {
                    state.durationMs = event.durationMs;
                    updateProcessTitle();
                }
                if (event.status === 'started') {
                    state.status = 'running';
                    updateProcessTitle();
                }
                if (event.status === 'completed') {
                    state.status = 'completed';
                    state.durationMs = event.durationMs || (Date.now() - startedAt);
                    updateProcessTitle();
                    if (ticker) clearInterval(ticker);
                    process.open = false;
                } else if (event.status === 'failed') {
                    state.status = 'completed';
                    state.durationMs = event.durationMs || (Date.now() - startedAt);
                    updateProcessTitle();
                    if (ticker) clearInterval(ticker);
                    process.open = false;
                }
                return;
            }

            if (event.type === 'answer_delta') {
                appendProcessText(event.text || '');
                process.open = true;
                return;
            }

            if (event.type === 'result') {
                removeFinalAnswerFromProcessText(event.content);
                state.answerText = event.content || state.answerText;
                state.changeReview = event.changeReview || state.changeReview;
                renderAnswer();
                state.status = 'completed';
                updateProcessTitle();
                if (ticker) clearInterval(ticker);
                process.open = false;
                return;
            }

            if (event.type === 'error') {
                state.answerText = state.answerText || ('处理失败：' + (event.error || '未知错误'));
                renderAnswer();
                state.status = 'completed';
                updateProcessTitle();
                if (ticker) clearInterval(ticker);
                process.open = false;
                return;
            }

            if (event.type === 'cancelled') {
                state.answerText = event.message || '已中断';
                renderAnswer();
                state.status = 'completed';
                updateProcessTitle();
                if (ticker) clearInterval(ticker);
                process.open = false;
                return;
            }

            if (event.type === 'file_change') {
                state.editCount += event.event === 'unlink' ? 0 : 1;
                if (event.path) state.readFiles.add(event.path);
                updateActivitySummary();
                return;
            }

            if (event.type === 'tool_start') {
                state.activeProcessTextSegment = null;
                ensureTool(event.tool);
                process.open = true;
                return;
            }

            if (event.type === 'tool_progress') {
                state.durationMs = event.elapsedMs || (Date.now() - startedAt);
                updateProcessTitle();
                return;
            }

            if (event.type === 'tool_end') {
                markTool(event);
                updateActivitySummary();
                scrollBottom();
            }
        }

        return {
            row: row,
            handleEvent: handleEvent,
        };
    }

    function renderPersistedMessage(opts) {
        var view = createMessage({
            messagesEl: opts.messagesEl,
            scrollBottom: opts.scrollBottom,
            persisted: true,
            open: false,
            createdAt: opts.createdAt,
        });
        var loop = opts.loop || {};
        var events = Array.isArray(loop.events) ? loop.events : [];
        events.forEach(function (event) {
            view.handleEvent(event);
        });
        view.handleEvent({
            type: 'result',
            content: opts.content || '',
            changeReview: opts.changeReview || null,
            contentTruncated: !!opts.contentTruncated,
            contentChars: opts.contentChars,
            fullContentLoader: opts.fullContentLoader || null,
        });
        return view;
    }

    async function consumeStreamResponse(res, opts) {
        var inactive = opts.allowInactive && res.status === 404;
        if (inactive) return { fallback: false, inactive: true };

        if (res.status === 409) return { fallback: true };
        if (!res.ok) {
            var err = await res.json().catch(function () { return {}; });
            throw new Error(err.error || '发送失败，请重试');
        }

        var reader = res.body.getReader();
        var decoder = new TextDecoder();
        var buffer = '';
        var resultPayload = null;

        while (true) {
            var chunk = await reader.read();
            if (chunk.done) break;
            buffer += decoder.decode(chunk.value, { stream: true });
            buffer = parseSseChunk(buffer, function (_eventName, data) {
                if (data && data.type === 'result') {
                    resultPayload = data;
                }
                if (data && data.type === 'context_usage' && data.usage && opts.onContextUsage) {
                    opts.onContextUsage(data.usage);
                } else if (data && data.type === 'result' && data.contextUsage && opts.onContextUsage) {
                    opts.onContextUsage(data.contextUsage);
                }
                opts.view.handleEvent(data);
            });
        }

        return { fallback: false, inactive: false, result: resultPayload };
    }

    async function stream(opts) {
        var res = await fetch('/api/sessions/' + opts.sessionId + '/messages/stream', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify(opts.body),
            signal: opts.signal,
        });
        return consumeStreamResponse(res, opts);
    }

    async function resume(opts) {
        opts.allowInactive = true;
        var res = await fetch('/api/sessions/' + opts.sessionId + '/messages/stream', {
            method: 'GET',
            signal: opts.signal,
        });
        return consumeStreamResponse(res, opts);
    }

    function canStream(providerType) {
        return providerType === 'claude-code' || providerType === 'codex';
    }

    window.ClaudeAgentLoop = {
        canStream: canStream,
        createMessage: createMessage,
        renderPersistedMessage: renderPersistedMessage,
        resume: resume,
        stream: stream,
    };
})();
