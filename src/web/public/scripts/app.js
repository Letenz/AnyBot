    // 图片灯箱：点击放大查看
    function openImageModal(src) {
        var overlay = document.createElement('div');
        overlay.className = 'image-modal-overlay';
        var img = document.createElement('img');
        img.className = 'image-modal-img';
        img.src = src;
        overlay.appendChild(img);
        document.body.appendChild(overlay);
        // 触发动画
        requestAnimationFrame(function () { overlay.classList.add('active'); });
        overlay.addEventListener('click', function (e) {
            if (e.target === overlay) {
                overlay.classList.remove('active');
                setTimeout(function () { overlay.remove(); }, 200);
            }
        });
        document.addEventListener('keydown', function handler(e) {
            if (e.key === 'Escape') {
                overlay.classList.remove('active');
                setTimeout(function () { overlay.remove(); }, 200);
                document.removeEventListener('keydown', handler);
            }
        });
    }

    function copyCode(btn) {
        var code = btn.closest('pre').querySelector('code');
        var text = code.textContent || code.innerText;
        navigator.clipboard.writeText(text).then(function () {
            btn.textContent = '已复制';
            setTimeout(function () {
                btn.textContent = '复制';
            }, 1500);
        });
    }

    (function () {
        const messagesEl = document.getElementById('messages');
        const inputEl = document.getElementById('chat-input');
        const sendBtn = document.getElementById('send-btn');
        const sidebar = document.getElementById('sidebar');
        const projectToggle = document.getElementById('project-toggle');
        const projectList = document.getElementById('project-list');
        const addProjectBtn = document.getElementById('add-project-btn');
        const historyToggle = document.getElementById('history-toggle');
        const historyList = document.getElementById('history-list');
        const addHistoryChatBtn = document.getElementById('add-history-chat-btn');
        const newChatBtn = document.getElementById('new-chat-btn');

        const modelSwitcher = document.getElementById('model-switcher');
        const modelBadge = document.getElementById('model-badge');
        const modelDropdown = document.getElementById('model-dropdown');
        const currentModelNameEl = document.getElementById('current-model-name');
        const settingsBtn = document.getElementById('settings-btn');
        const settingsView = document.getElementById('settings-view');
        const settingsCancelBtn = document.getElementById('settings-cancel-btn');
        const settingsSaveBtn = document.getElementById('settings-save-btn');
        const settingsSaveStatus = document.getElementById('settings-save-status');
        const settingsTitle = document.getElementById('settings-title');
        const settingsSubtitle = document.getElementById('settings-subtitle');
        const settingsNavItems = Array.prototype.slice.call(document.querySelectorAll('.settings-nav-item'));
        const settingsTabPanels = Array.prototype.slice.call(document.querySelectorAll('.settings-tab-panel'));
        const settingsProviderSelect = document.getElementById('settings-provider-select');
        const settingsProviderCombobox = document.getElementById('settings-provider-combobox');
        const settingsProviderTrigger = document.getElementById('settings-provider-trigger');
        const settingsProviderCurrent = document.getElementById('settings-provider-current');
        const settingsProviderMenu = document.getElementById('settings-provider-menu');
        const settingsThemeGroup = document.getElementById('settings-theme-group');
        const settingsSandboxGroup = document.getElementById('settings-sandbox-group');
        const settingsLanguageSelect = document.getElementById('settings-language-select');
        const settingsOpenLogin = document.getElementById('settings-open-login');
        const settingsOpenWindow = document.getElementById('settings-open-window');
        const settingsWebPort = document.getElementById('settings-web-port');
        const settingsProviderModelSelect = document.getElementById('settings-provider-model-select');
        const settingsProviderStatus = document.getElementById('settings-provider-status');
        const settingsProviderBinFields = document.getElementById('settings-provider-bin-fields');
        const settingsProviderExtraFields = document.getElementById('settings-provider-extra-fields');
        const settingsProviderDetectBtn = document.getElementById('settings-provider-detect-btn');
        const settingsDangerConfirm = document.getElementById('settings-danger-confirm');
        const settingsDefaultWorkdir = document.getElementById('settings-default-workdir');
        const settingsWorkdirPickBtn = document.getElementById('settings-workdir-pick-btn');
        const settingsProjectsEntryBtn = document.getElementById('settings-projects-entry-btn');
        const settingsLogLevel = document.getElementById('settings-log-level');
        const settingsLogContent = document.getElementById('settings-log-content');
        const settingsLogPrompt = document.getElementById('settings-log-prompt');
        const settingsOpenLogsBtn = document.getElementById('settings-open-logs-btn');
        const settingsClearLogsBtn = document.getElementById('settings-clear-logs-btn');
        const settingsOpenDataBtn = document.getElementById('settings-open-data-btn');
        const settingsClearUploadsBtn = document.getElementById('settings-clear-uploads-btn');
        const settingsExportDataBtn = document.getElementById('settings-export-data-btn');
        const settingsImportDataBtn = document.getElementById('settings-import-data-btn');
        const settingsImportFile = document.getElementById('settings-import-file');
        const settingsClearHistoryBtn = document.getElementById('settings-clear-history-btn');
        const contextUsageEl = document.getElementById('context-usage');
        const contextUsageRingEl = document.getElementById('context-usage-ring');
        const contextUsagePercentEl = document.getElementById('context-usage-percent');
        const contextUsageTokensEl = document.getElementById('context-usage-tokens');
        const contextUsageProviderEl = document.getElementById('context-usage-provider');

        let currentSessionId = null;
        let currentSessionProjectId = null;
        let currentSessionProvider = null;
        let activeProjectId = null;
        let isTyping = false;
        let isCancellingResponse = false;
        let sessions = [];
        let projects = [];
        let modelConfig = null;
        let providerData = null;
        let sandboxConfig = null;
        let appSettingsPayload = null;
        let appSettings = null;
        let settingsModelConfig = null;
        let selectedSandbox = null;
        let activeSettingsTab = 'general';
        let latestContextUsage = null;
        let activeStreamSessionId = null;
        let activeStreamAbortController = null;
        let isBatchRenderingMessages = false;
        let currentSessionHasMoreMessages = false;
        let isLoadingOlderMessages = false;
        let isProjectsCollapsed = localStorage.getItem('projectsCollapsed') === 'true';
        let isHistoryCollapsed = localStorage.getItem('historyCollapsed') === 'true';
        let expandedProjectIds = readStoredSet('expandedProjectIds');
        const SESSION_MESSAGE_PAGE_SIZE = 40;
        const LARGE_MESSAGE_PREVIEW_CHARS = 20000;
        const THEME_STORAGE_KEY = 'webuiTheme';
        const HIGHLIGHT_DARK_CSS = 'https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github-dark-dimmed.min.css';
        const HIGHLIGHT_LIGHT_CSS = 'https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github.min.css';
        const SIDEBAR_REFRESH_INTERVAL_MS = 5000;
        const systemThemeQuery = window.matchMedia ? window.matchMedia('(prefers-color-scheme: light)') : null;
        let currentThemeSetting = readStoredTheme();
        let sidebarRefreshTimer = null;
        let isSidebarRefreshInFlight = false;

        // 附件相关
        const fileInput = document.getElementById('file-input');
        const attachBtn = document.getElementById('attach-btn');
        const attachmentPreview = document.getElementById('attachment-preview');
        const dropOverlay = document.getElementById('drop-overlay');
        let pendingAttachments = []; // { path, name, size, isImage, localUrl? }

        const IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.svg', '.ico', '.tiff', '.tif', '.heic', '.heif', '.avif'];
        const SEND_BUTTON_ICON = '<svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true"><path d="M2 7h10M7.5 2.5L12 7l-4.5 4.5" stroke="white" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
        const STOP_BUTTON_ICON = '<svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true"><rect x="3.5" y="3.5" width="7" height="7" rx="1.4" fill="white"/></svg>';

        function readStoredTheme() {
            var value = localStorage.getItem(THEME_STORAGE_KEY);
            return ['light', 'dark', 'system'].includes(value) ? value : 'dark';
        }

        function getEffectiveTheme(setting) {
            if (setting === 'system') {
                return systemThemeQuery && systemThemeQuery.matches ? 'light' : 'dark';
            }
            return setting === 'light' ? 'light' : 'dark';
        }

        function applyTheme(setting) {
            currentThemeSetting = ['light', 'dark', 'system'].includes(setting) ? setting : 'dark';
            var effectiveTheme = getEffectiveTheme(currentThemeSetting);
            document.documentElement.dataset.theme = effectiveTheme;
            document.documentElement.dataset.themeSetting = currentThemeSetting;
            document.documentElement.style.colorScheme = effectiveTheme;

            var highlightTheme = document.getElementById('highlight-theme');
            if (highlightTheme) {
                highlightTheme.href = effectiveTheme === 'light' ? HIGHLIGHT_LIGHT_CSS : HIGHLIGHT_DARK_CSS;
            }

            if (settingsThemeGroup) {
                Array.prototype.forEach.call(settingsThemeGroup.querySelectorAll('.theme-option'), function (button) {
                    var isActive = button.dataset.themeValue === currentThemeSetting;
                    button.classList.toggle('active', isActive);
                    button.setAttribute('aria-checked', isActive ? 'true' : 'false');
                });
            }

            if (latestContextUsage) updateContextUsage(latestContextUsage);
        }

        function setTheme(setting) {
            localStorage.setItem(THEME_STORAGE_KEY, setting);
            applyTheme(setting);
        }

        applyTheme(currentThemeSetting);

        if (settingsThemeGroup) {
            settingsThemeGroup.addEventListener('click', function (e) {
                var button = e.target.closest('.theme-option');
                if (!button || !settingsThemeGroup.contains(button)) return;
                var theme = button.dataset.themeValue;
                setTheme(theme);
                persistAppSettingsPatch({general: {theme: theme}}, '已保存');
            });
        }

        if (systemThemeQuery) {
            var handleSystemThemeChange = function () {
                if (currentThemeSetting === 'system') applyTheme('system');
            };
            if (systemThemeQuery.addEventListener) {
                systemThemeQuery.addEventListener('change', handleSystemThemeChange);
            } else if (systemThemeQuery.addListener) {
                systemThemeQuery.addListener(handleSystemThemeChange);
            }
        }

        function getFileTypeClass(name) {
            var ext = (name.match(/\.[^.]+$/) || [''])[0].toLowerCase();
            if (['.doc', '.docx', '.txt', '.rtf'].includes(ext)) return 'file-type-doc';
            if (['.xls', '.xlsx', '.csv'].includes(ext)) return 'file-type-sheet';
            if (ext === '.pdf') return 'file-type-pdf';
            if (['.js', '.ts', '.py', '.java', '.go', '.rs', '.cpp', '.c', '.html', '.css', '.json', '.xml', '.yaml', '.yml', '.sh', '.sql'].includes(ext)) return 'file-type-code';
            return 'file-type-other';
        }

        function getFileExt(name) {
            var ext = (name.match(/\.[^.]+$/) || [''])[0].replace('.', '').toUpperCase();
            return ext.slice(0, 4) || 'FILE';
        }

        function formatSize(bytes) {
            if (bytes < 1024) return bytes + ' B';
            if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
            return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
        }

        function updateSendBtnState() {
            var isRunning = !!isTyping;
            sendBtn.classList.toggle('is-stop', isRunning);
            sendBtn.innerHTML = isRunning ? STOP_BUTTON_ICON : SEND_BUTTON_ICON;
            sendBtn.title = isRunning ? (isCancellingResponse ? '正在中断' : '中断') : '发送';
            sendBtn.setAttribute('aria-label', sendBtn.title);
            sendBtn.disabled = isRunning
                ? isCancellingResponse
                : (inputEl.value.trim() === '' && pendingAttachments.length === 0);
        }

        function resizeChatInput() {
            inputEl.style.height = 'auto';
            inputEl.style.overflowY = inputEl.scrollHeight > 160 ? 'auto' : 'hidden';
            inputEl.style.height = Math.min(inputEl.scrollHeight, 160) + 'px';
        }

        function renderAttachmentPreview() {
            if (pendingAttachments.length === 0) {
                attachmentPreview.style.display = 'none';
                attachmentPreview.innerHTML = '';
                return;
            }
            attachmentPreview.style.display = 'flex';
            attachmentPreview.innerHTML = '';
            pendingAttachments.forEach(function (att, idx) {
                var item = document.createElement('div');
                item.className = 'attachment-item' + (att.uploading ? ' uploading' : '');

                if (att.isImage && att.localUrl) {
                    var thumb = document.createElement('img');
                    thumb.className = 'attachment-item-thumb';
                    thumb.src = att.localUrl;
                    thumb.alt = att.name;
                    item.appendChild(thumb);
                } else {
                    var icon = document.createElement('div');
                    icon.className = 'attachment-item-icon ' + getFileTypeClass(att.name);
                    icon.textContent = getFileExt(att.name);
                    item.appendChild(icon);
                }

                var info = document.createElement('div');
                info.className = 'attachment-item-info';
                info.innerHTML = '<div class="attachment-item-name">' + escapeHtml(att.name) + '</div>' +
                    '<div class="attachment-item-size">' + formatSize(att.size) + '</div>';
                item.appendChild(info);

                if (!att.uploading) {
                    var removeBtn = document.createElement('button');
                    removeBtn.className = 'attachment-item-remove';
                    removeBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>';
                    removeBtn.addEventListener('click', function () {
                        pendingAttachments.splice(idx, 1);
                        renderAttachmentPreview();
                        updateSendBtnState();
                    });
                    item.appendChild(removeBtn);
                }

                attachmentPreview.appendChild(item);
            });
        }

        async function uploadFile(file) {
            var isImage = IMAGE_EXTS.some(function (ext) {
                return file.name.toLowerCase().endsWith(ext);
            });
            var localUrl = isImage ? URL.createObjectURL(file) : null;
            var tempAtt = { name: file.name, size: file.size, isImage: isImage, localUrl: localUrl, uploading: true, path: '' };
            pendingAttachments.push(tempAtt);
            renderAttachmentPreview();
            updateSendBtnState();

            try {
                var formData = new FormData();
                formData.append('file', file);
                var res = await fetch('/api/upload', { method: 'POST', body: formData });
                if (!res.ok) throw new Error('上传失败');
                var data = await res.json();
                tempAtt.path = data.path;
                tempAtt.uploading = false;
                renderAttachmentPreview();
                updateSendBtnState();
            } catch (e) {
                var idx = pendingAttachments.indexOf(tempAtt);
                if (idx !== -1) pendingAttachments.splice(idx, 1);
                renderAttachmentPreview();
                updateSendBtnState();
                showError('文件上传失败: ' + (e.message || '未知错误'));
            }
        }

        async function uploadFiles(files) {
            for (var i = 0; i < files.length; i++) {
                await uploadFile(files[i]);
            }
        }

        inputEl.addEventListener('input', function () {
            resizeChatInput();
            updateSendBtnState();
        });

        inputEl.addEventListener('keydown', function (e) {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                if (!isTyping && !sendBtn.disabled) sendMessage();
            }
        });

        sendBtn.addEventListener('click', function () {
            if (isTyping) {
                cancelCurrentResponse();
                return;
            }
            sendMessage();
        });
        newChatBtn.addEventListener('click', function () {
            createNewChat();
        });
        projectToggle.addEventListener('click', toggleProjects);
        addProjectBtn.addEventListener('click', addProject);
        historyToggle.addEventListener('click', toggleHistory);
        addHistoryChatBtn.addEventListener('click', function (e) {
            e.stopPropagation();
            createNewChat(null, { force: true });
        });

        // 附件按钮 - 点击触发文件选择
        attachBtn.addEventListener('click', function () {
            fileInput.click();
        });

        fileInput.addEventListener('change', function () {
            if (this.files && this.files.length > 0) {
                uploadFiles(this.files);
            }
            this.value = ''; // 重置以便重新选择同一文件
        });

        // 粘贴图片
        inputEl.addEventListener('paste', function (e) {
            var items = e.clipboardData && e.clipboardData.items;
            if (!items) return;
            var files = [];
            for (var i = 0; i < items.length; i++) {
                if (items[i].kind === 'file') {
                    var file = items[i].getAsFile();
                    if (file) files.push(file);
                }
            }
            if (files.length > 0) {
                e.preventDefault();
                uploadFiles(files);
            }
        });

        // 拖拽文件
        var dragCounter = 0;
        var chatViewEl = document.getElementById('chat-view');

        chatViewEl.addEventListener('dragenter', function (e) {
            e.preventDefault();
            dragCounter++;
            dropOverlay.style.display = 'flex';
        });

        chatViewEl.addEventListener('dragleave', function (e) {
            e.preventDefault();
            dragCounter--;
            if (dragCounter <= 0) {
                dragCounter = 0;
                dropOverlay.style.display = 'none';
            }
        });

        chatViewEl.addEventListener('dragover', function (e) {
            e.preventDefault();
        });

        chatViewEl.addEventListener('drop', function (e) {
            e.preventDefault();
            dragCounter = 0;
            dropOverlay.style.display = 'none';
            if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length > 0) {
                uploadFiles(e.dataTransfer.files);
            }
        });

        function escapeHtml(s) {
            return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        }

        if (typeof marked !== 'undefined') {
            var markedRenderer = new marked.Renderer();
            markedRenderer.code = function (obj) {
                var code = (typeof obj === 'string') ? obj : (obj.text || '');
                var lang = (typeof obj === 'string') ? '' : (obj.lang || '');
                var headerHtml = '<div class="code-header"><span class="code-lang">' + escapeHtml(lang || 'text') + '</span><button class="code-copy" onclick="copyCode(this)">复制</button></div>';
                if (lang && typeof hljs !== 'undefined' && hljs.getLanguage(lang)) {
                    try {
                        var highlighted = hljs.highlight(code, {language: lang}).value;
                        return '<pre>' + headerHtml + '<code class="hljs language-' + escapeHtml(lang) + '">' + highlighted + '</code></pre>';
                    } catch (_) {
                    }
                }
                return '<pre>' + headerHtml + '<code class="hljs">' + escapeHtml(code) + '</code></pre>';
            };

            // 自定义图片渲染：将本地绝对路径改写为通过后端代理访问，限制尺寸并支持点击放大
            markedRenderer.image = function (obj) {
                var href = (typeof obj === 'string') ? obj : (obj.href || '');
                var title = (typeof obj === 'string') ? '' : (obj.title || '');
                var alt = (typeof obj === 'string') ? '' : (obj.text || '');
                // 本地绝对路径：以 / 开头且不是 Web 路径
                if (href.startsWith('/') && !href.startsWith('/api')) {
                    href = '/api/local-file?path=' + encodeURIComponent(href);
                }
                return '<img src="' + href + '" alt="' + escapeHtml(alt) + '"'
                    + (title ? ' title="' + escapeHtml(title) + '"' : '')
                    + ' class="chat-image" onclick="openImageModal(this.src)" />';
            };

            marked.setOptions({
                renderer: markedRenderer,
                gfm: true,
                breaks: true,
            });
        }

        function scrollBottom() {
            if (isBatchRenderingMessages) return;
            messagesEl.scrollTop = messagesEl.scrollHeight;
        }

        function clearEmpty() {
            var empty = document.getElementById('empty-state');
            if (empty) empty.remove();
        }

        async function fetchFullMessageContent(messageId) {
            if (!currentSessionId || !messageId) throw new Error('无法加载完整内容');
            var res = await fetch('/api/sessions/' + currentSessionId + '/messages/' + encodeURIComponent(messageId) + '/content');
            if (!res.ok) throw new Error('加载完整内容失败');
            var data = await res.json();
            return data.content || '';
        }

        function renderAssistantText(content, text, opts) {
            opts = opts || {};
            var fullText = String(text || '');
            var renderText = fullText;
            var isLarge = opts.contentTruncated || fullText.length > LARGE_MESSAGE_PREVIEW_CHARS;
            if (isLarge) {
                renderText = opts.contentTruncated
                    ? fullText
                    : fullText.slice(0, LARGE_MESSAGE_PREVIEW_CHARS) + '\n\n...[内容较长，已折叠]';
            }
            try {
                content.innerHTML = marked.parse(renderText);
            } catch (e) {
                content.textContent = renderText;
            }
            if (!isLarge) return;
            var expand = document.createElement('button');
            expand.className = 'large-message-expand';
            expand.type = 'button';
            expand.textContent = opts.contentChars ? ('展开完整内容（' + formatTokenCount(opts.contentChars) + ' 字符）') : '展开完整内容';
            expand.addEventListener('click', async function () {
                expand.disabled = true;
                expand.textContent = '加载中...';
                var nextText = fullText;
                if (opts.contentTruncated && opts.messageId) {
                    try {
                        nextText = await fetchFullMessageContent(opts.messageId);
                    } catch (e) {
                        showError(e.message || '加载完整内容失败');
                        expand.disabled = false;
                        expand.textContent = '展开完整内容';
                        return;
                    }
                }
                try {
                    content.innerHTML = marked.parse(nextText);
                } catch (e) {
                    content.textContent = nextText;
                }
            });
            content.appendChild(expand);
        }

        function showEmptyState() {
            messagesEl.innerHTML =
                '<div id="empty-state">' +
                '<div class="empty-icon">Ab</div>' +
                '<div class="empty-title">AnyBot 已就绪</div>' +
                '<div class="empty-sub">发送消息，开始你的对话</div>' +
                '</div>';
        }

        function appendMessage(role, text, attachments, changeReview, opts) {
            clearEmpty();
            var row = document.createElement('div');
            row.className = 'message-row ' + role;

            if (role === 'ai') {
                var bubble = document.createElement('div');
                bubble.className = 'bubble';

                var avatar = document.createElement('div');
                avatar.className = 'avatar ai-avatar';
                avatar.textContent = 'Ab';

                var content = document.createElement('div');
                content.className = 'message-content';
                renderAssistantText(content, text, opts);
                if (changeReview && window.ChangeReview) {
                    var reviewCard = window.ChangeReview.render({
                        review: changeReview,
                        scrollBottom: scrollBottom,
                    });
                    if (reviewCard) content.appendChild(reviewCard);
                }

                bubble.appendChild(avatar);
                bubble.appendChild(content);
                row.appendChild(bubble);
            } else {
                var bubble = document.createElement('div');
                bubble.className = 'bubble';

                var content = document.createElement('div');
                content.className = 'message-content';
                var userText = document.createElement('div');
                userText.textContent = text;
                content.appendChild(userText);
                if (opts && opts.contentTruncated && opts.messageId) {
                    var userExpand = document.createElement('button');
                    userExpand.className = 'large-message-expand';
                    userExpand.type = 'button';
                    userExpand.textContent = opts.contentChars ? ('展开完整内容（' + formatTokenCount(opts.contentChars) + ' 字符）') : '展开完整内容';
                    userExpand.addEventListener('click', async function () {
                        userExpand.disabled = true;
                        userExpand.textContent = '加载中...';
                        try {
                            userText.textContent = await fetchFullMessageContent(opts.messageId);
                            userExpand.remove();
                        } catch (e) {
                            showError(e.message || '加载完整内容失败');
                            userExpand.disabled = false;
                            userExpand.textContent = '展开完整内容';
                        }
                    });
                    content.appendChild(userExpand);
                }

                // 显示附件：图片渲染缩略图，其他渲染标签
                if (attachments && attachments.length > 0) {
                    var attDiv = document.createElement('div');
                    attDiv.className = 'message-attachments';
                    attachments.forEach(function (att) {
                        var name = (typeof att === 'string') ? att : att.name;
                        var attPath = (typeof att === 'string') ? null : att.path;
                        var isImg = IMAGE_EXTS.some(function (ext) { return name.toLowerCase().endsWith(ext); });

                        if (isImg && attPath) {
                            // 图片缩略图
                            var imgSrc = '/api/local-file?path=' + encodeURIComponent(attPath);
                            var img = document.createElement('img');
                            img.className = 'chat-image user-attachment-image';
                            img.src = imgSrc;
                            img.alt = name;
                            img.onclick = function () { openImageModal(imgSrc); };
                            attDiv.appendChild(img);
                        } else {
                            // 非图片附件标签
                            var tag = document.createElement('span');
                            tag.className = 'message-attachment-tag';
                            tag.innerHTML = '<svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M14 8.5l-5.5 5.5a3.5 3.5 0 01-5-5L9 3.5a2 2 0 013 3L6.5 12a.5.5 0 01-.7-.7L11 6" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg> ' + escapeHtml(name);
                            attDiv.appendChild(tag);
                        }
                    });
                    content.appendChild(attDiv);
                }

                bubble.appendChild(content);
                row.appendChild(bubble);
            }

            messagesEl.appendChild(row);
            scrollBottom();
            return row;
        }

        function getOldestRenderedMessageId() {
            var first = messagesEl.querySelector('.message-row[data-message-id]');
            return first ? Number(first.dataset.messageId || 0) : null;
        }

        function removeOlderMessagesControl() {
            var existing = document.getElementById('load-older-messages');
            if (existing) existing.remove();
        }

        function renderOlderMessagesControl() {
            removeOlderMessagesControl();
            if (!currentSessionHasMoreMessages) return;
            var btn = document.createElement('button');
            btn.id = 'load-older-messages';
            btn.className = 'load-older-messages';
            btn.type = 'button';
            btn.textContent = isLoadingOlderMessages ? '加载中...' : '加载更早消息';
            btn.disabled = isLoadingOlderMessages;
            btn.addEventListener('click', loadOlderMessages);
            messagesEl.insertBefore(btn, messagesEl.firstChild);
        }

        function renderMessageRecord(m, beforeNode) {
            var row = null;
            var attInfo = null;
            var meta = parseMessageMetadata(m.metadata);
            if (meta.attachments && meta.attachments.length > 0) {
                attInfo = meta.attachments;
            }
            if (m.role === 'assistant' && meta.claudeAgentLoop && window.ClaudeAgentLoop && window.ClaudeAgentLoop.renderPersistedMessage) {
                clearEmpty();
                var view = window.ClaudeAgentLoop.renderPersistedMessage({
                    messagesEl: messagesEl,
                    scrollBottom: scrollBottom,
                    content: m.content,
                    loop: meta.claudeAgentLoop,
                    changeReview: meta.changeReview,
                    contentTruncated: !!m.contentTruncated,
                    contentChars: m.contentChars,
                    fullContentLoader: m.contentTruncated
                        ? function () { return fetchFullMessageContent(m.id); }
                        : null,
                });
                row = view && view.row;
                var usageEvents = Array.isArray(meta.claudeAgentLoop.events)
                    ? meta.claudeAgentLoop.events.filter(function (event) { return event && event.type === 'context_usage' && event.usage; })
                    : [];
                if (usageEvents.length > 0) updateContextUsage(usageEvents[usageEvents.length - 1].usage);
            } else {
                row = appendMessage(m.role === 'user' ? 'user' : 'ai', m.content, attInfo, meta.changeReview, {
                    messageId: m.id,
                    contentTruncated: !!m.contentTruncated,
                    contentChars: m.contentChars,
                });
            }
            if (row) {
                row.dataset.messageId = String(m.id);
                if (beforeNode && row !== beforeNode) messagesEl.insertBefore(row, beforeNode);
            }
            return row;
        }

        async function loadOlderMessages() {
            if (!currentSessionId || isLoadingOlderMessages) return;
            var beforeId = getOldestRenderedMessageId();
            if (!beforeId) return;
            var anchor = messagesEl.querySelector('.message-row[data-message-id]');
            var previousScrollHeight = messagesEl.scrollHeight;
            try {
                isLoadingOlderMessages = true;
                renderOlderMessagesControl();
                var res = await fetch('/api/sessions/' + currentSessionId + '/messages?before=' + encodeURIComponent(beforeId) + '&limit=' + SESSION_MESSAGE_PAGE_SIZE);
                if (!res.ok) throw new Error('加载更早消息失败');
                var data = await res.json();
                removeOlderMessagesControl();
                isBatchRenderingMessages = true;
                try {
                    (data.messages || []).forEach(function (m) {
                        renderMessageRecord(m, anchor);
                    });
                } finally {
                    isBatchRenderingMessages = false;
                }
                currentSessionHasMoreMessages = !!data.hasMoreMessages;
                renderOlderMessagesControl();
                messagesEl.scrollTop += messagesEl.scrollHeight - previousScrollHeight;
            } catch (e) {
                showError(e.message || '加载更早消息失败');
            } finally {
                isLoadingOlderMessages = false;
                renderOlderMessagesControl();
            }
        }

        function showTyping() {
            clearEmpty();
            var row = document.createElement('div');
            row.className = 'message-row ai';
            row.id = 'typing-row';
            row.innerHTML =
                '<div class="bubble">' +
                '<div class="avatar ai-avatar">Ab</div>' +
                '<div class="message-content">' +
                '<div class="typing-indicator">' +
                '<div class="typing-dot"></div>' +
                '<div class="typing-dot"></div>' +
                '<div class="typing-dot"></div>' +
                '</div>' +
                '</div>' +
                '</div>';
            messagesEl.appendChild(row);
            scrollBottom();
        }

        function removeTyping() {
            var t = document.getElementById('typing-row');
            if (t) t.remove();
        }

        function showError(msg) {
            var toast = document.createElement('div');
            toast.className = 'error-toast';
            toast.textContent = msg;
            document.body.appendChild(toast);
            setTimeout(function () {
                toast.remove();
            }, 4000);
        }

        function parseMessageMetadata(raw) {
            if (!raw) return {};
            try {
                return JSON.parse(raw) || {};
            } catch (_) {
                return {};
            }
        }

        function formatTokenCount(value) {
            var n = Number(value || 0);
            if (!Number.isFinite(n) || n <= 0) return '0';
            if (n >= 1000000) return (n / 1000000).toFixed(n >= 10000000 ? 0 : 1).replace(/\.0$/, '') + 'm';
            if (n >= 1000) return Math.round(n / 1000) + 'k';
            return String(Math.round(n));
        }

        function contextUsageColor(percent) {
            if (percent >= 90) return '#ef4444';
            if (percent >= 70) return '#f59e0b';
            return '#9ca3af';
        }

        function updateContextUsage(usage) {
            latestContextUsage = usage || {
                usedTokens: 0,
                maxTokens: 0,
                usedPercentage: 0,
                remainingPercentage: 100,
                source: '',
            };
            if (!contextUsageEl || !contextUsageRingEl || !latestContextUsage) return;

            var usedPercent = Math.max(0, Math.min(100, Number(latestContextUsage.usedPercentage || 0)));
            var remainingPercent = Math.max(0, Math.round((100 - usedPercent) * 10) / 10);
            var usedTokens = Number(latestContextUsage.usedTokens || 0);
            var maxTokens = Number(latestContextUsage.maxTokens || 0);
            var color = contextUsageColor(usedPercent);
            var degrees = usedPercent * 3.6;

            contextUsageEl.classList.toggle('has-data', usedTokens > 0 && maxTokens > 0);
            contextUsageRingEl.style.background =
                'radial-gradient(circle at center, var(--input-bg) 48%, transparent 50%), ' +
                'conic-gradient(' + color + ' ' + degrees + 'deg, var(--ring-track) ' + degrees + 'deg)';

            if (contextUsagePercentEl) {
                contextUsagePercentEl.textContent =
                    Math.round(usedPercent) + '% 已用（剩余 ' + Math.round(remainingPercent) + '%）';
            }
            if (contextUsageTokensEl) {
                contextUsageTokensEl.textContent =
                    '已用 ' + formatTokenCount(usedTokens) + ' token，共 ' + formatTokenCount(maxTokens);
            }
            if (contextUsageProviderEl) {
                contextUsageProviderEl.textContent = '';
            }
        }

        function groupSessionsByDate(list) {
            var now = new Date();
            var today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
            var yesterday = today - 86400000;
            var weekAgo = today - 7 * 86400000;

            var groups = {'今天': [], '昨天': [], '上周': [], '更早': []};

            list.forEach(function (s) {
                var t = s.updatedAt || s.createdAt;
                if (t >= today) groups['今天'].push(s);
                else if (t >= yesterday) groups['昨天'].push(s);
                else if (t >= weekAgo) groups['上周'].push(s);
                else groups['更早'].push(s);
            });

            return groups;
        }

        function readStoredSet(key) {
            try {
                return new Set(JSON.parse(localStorage.getItem(key) || '[]'));
            } catch (_) {
                return new Set();
            }
        }

        function saveStoredSet(key, value) {
            localStorage.setItem(key, JSON.stringify(Array.from(value)));
        }

        function folderIcon(open) {
            return open
                ? '<svg class="project-icon" viewBox="0 0 16 16" fill="none"><path d="M1.8 5.5h12.4l-1.1 6.3c-.1.7-.7 1.2-1.5 1.2H4.1c-.7 0-1.3-.5-1.5-1.2L1.8 5.5Z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><path d="M2.4 5.5V3.6c0-.6.5-1.1 1.1-1.1h3l1.4 1.6h4.3c.6 0 1.1.5 1.1 1.1v.3" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>'
                : '<svg class="project-icon" viewBox="0 0 16 16" fill="none"><path d="M2.4 12.7V3.6c0-.6.5-1.1 1.1-1.1h3l1.4 1.6h4.6c.6 0 1.1.5 1.1 1.1v7.5H2.4Z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>';
        }

        function formatRelativeAge(ts) {
            var diff = Date.now() - (ts || Date.now());
            var days = Math.max(0, Math.floor(diff / 86400000));
            if (days === 0) return '今天';
            if (days < 30) return days + ' 天';
            var months = Math.floor(days / 30);
            return months + ' 月';
        }

        function updateProjectsCollapsedState() {
            sidebar.classList.toggle('projects-collapsed', isProjectsCollapsed);
            projectToggle.setAttribute('aria-expanded', String(!isProjectsCollapsed));
            projectToggle.title = isProjectsCollapsed ? '展开项目列表' : '折叠项目列表';
        }

        function toggleProjects() {
            isProjectsCollapsed = !isProjectsCollapsed;
            localStorage.setItem('projectsCollapsed', String(isProjectsCollapsed));
            updateProjectsCollapsedState();
        }

        function updateHistoryCollapsedState() {
            sidebar.classList.toggle('history-collapsed', isHistoryCollapsed);
            historyToggle.setAttribute('aria-expanded', String(!isHistoryCollapsed));
            historyToggle.title = isHistoryCollapsed ? '展开对话列表' : '折叠对话列表';
        }

        function toggleHistory() {
            isHistoryCollapsed = !isHistoryCollapsed;
            localStorage.setItem('historyCollapsed', String(isHistoryCollapsed));
            updateHistoryCollapsedState();
        }

        function createSourceBadge(s) {
            var effectiveSource = (s.source && s.source !== 'web') ? s.source : 'web';
            var meta = CHANNEL_META[effectiveSource];
            var badge = document.createElement('span');
            badge.className = 'history-item-source ' + (meta ? meta.iconClass : 'default');
            badge.textContent = meta ? meta.badge : effectiveSource;
            return badge;
        }

        function createHistoryItem(s) {
            var item = document.createElement('div');
            item.className = 'history-item' + (currentView === 'chat' && s.id === currentSessionId ? ' active' : '');
            item.dataset.id = s.id;

            var badge = createSourceBadge(s);
            item.appendChild(badge);

            var text = document.createElement('span');
            text.className = 'history-item-text';
            text.textContent = s.title;

            var del = document.createElement('button');
            del.className = 'history-item-delete';
            del.innerHTML = '<svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>';
            del.addEventListener('click', function (e) {
                e.stopPropagation();
                deleteSession(s.id);
            });

            item.appendChild(text);
            item.appendChild(del);

            item.addEventListener('click', function () {
                loadSession(s.id);
            });

            return item;
        }

        function renderHistory() {
            historyList.innerHTML = '';
            var globalSessions = sessions.filter(function (s) { return !s.projectId; });
            var groups = groupSessionsByDate(globalSessions);

            Object.keys(groups).forEach(function (label) {
                var items = groups[label];
                if (items.length === 0) return;

                var group = document.createElement('div');
                group.className = 'history-group';

                var groupLabel = document.createElement('div');
                groupLabel.className = 'history-group-label';
                groupLabel.textContent = label;
                group.appendChild(groupLabel);

                items.forEach(function (s) {
                    group.appendChild(createHistoryItem(s));
                });

                historyList.appendChild(group);
            });
        }

        function selectProject(projectId) {
            activeProjectId = projectId;
            expandedProjectIds.add(projectId);
            saveStoredSet('expandedProjectIds', expandedProjectIds);
            if (currentView !== 'chat') showChatView();
            renderProjects();
        }

        function renderProjectSessions(projectId) {
            var list = document.createElement('div');
            var projectSessions = sessions.filter(function (s) { return s.projectId === projectId; });
            if (projectSessions.length === 0) {
                var empty = document.createElement('div');
                empty.className = 'project-empty';
                empty.textContent = '暂无对话';
                list.appendChild(empty);
                return list;
            }

            projectSessions.forEach(function (s) {
                var btn = document.createElement('div');
                btn.className = 'project-session-item' + (currentView === 'chat' && s.id === currentSessionId ? ' active' : '');
                btn.setAttribute('role', 'button');
                btn.tabIndex = 0;
                btn.dataset.id = s.id;
                btn.innerHTML =
                    '<span class="project-session-source"></span>' +
                    '<span class="project-session-title"></span>' +
                    '<span class="project-session-age"></span>' +
                    '<button class="project-session-delete" type="button" title="删除对话" aria-label="删除对话">' +
                    '<svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>' +
                    '</button>';
                btn.replaceChild(createSourceBadge(s), btn.querySelector('.project-session-source'));
                btn.querySelector('.project-session-title').textContent = s.title;
                btn.querySelector('.project-session-age').textContent = formatRelativeAge(s.updatedAt || s.createdAt);
                btn.querySelector('.project-session-delete').addEventListener('click', function (e) {
                    e.stopPropagation();
                    deleteSession(s.id);
                });
                btn.addEventListener('click', function (e) {
                    e.stopPropagation();
                    loadSession(s.id);
                });
                btn.addEventListener('keydown', function (e) {
                    if (e.target !== btn) return;
                    if (e.key !== 'Enter' && e.key !== ' ') return;
                    e.preventDefault();
                    loadSession(s.id);
                });
                list.appendChild(btn);
            });

            return list;
        }

        function renderProjects() {
            projectList.innerHTML = '';
            projects.forEach(function (project) {
                var isExpanded = expandedProjectIds.has(project.id);
                var row = document.createElement('div');
                row.className = 'project-item' + (activeProjectId === project.id ? ' active' : '');
                row.setAttribute('role', 'button');
                row.tabIndex = 0;
                row.dataset.id = project.id;
                row.setAttribute('aria-expanded', String(isExpanded));
                row.innerHTML =
                    folderIcon(isExpanded) +
                    '<span class="project-name"></span>' +
                    '<button class="project-create-chat" type="button" title="新对话" aria-label="在当前项目新建对话">' +
                    '<svg width="13" height="13" viewBox="0 0 13 13" fill="none" aria-hidden="true">' +
                    '<path d="M6.5 1.5v10M1.5 6.5h10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>' +
                    '</svg>' +
                    '</button>';
                row.querySelector('.project-name').textContent = project.name;
                row.addEventListener('click', function () {
                    if (activeProjectId === project.id) {
                        if (isExpanded) {
                            expandedProjectIds.delete(project.id);
                        } else {
                            expandedProjectIds.add(project.id);
                        }
                        saveStoredSet('expandedProjectIds', expandedProjectIds);
                        renderProjects();
                        return;
                    }
                    selectProject(project.id);
                });
                row.addEventListener('keydown', function (e) {
                    if (e.target !== row) return;
                    if (e.key !== 'Enter' && e.key !== ' ') return;
                    e.preventDefault();
                    row.click();
                });
                row.querySelector('.project-create-chat').addEventListener('click', function (e) {
                    e.stopPropagation();
                    createNewChat(project.id, { force: true });
                });
                projectList.appendChild(row);

                if (!isExpanded) return;

                var details = document.createElement('div');
                details.className = 'project-details';
                details.appendChild(renderProjectSessions(project.id));

                projectList.appendChild(details);
            });
        }

        function updateSidebarSelection() {
            var isChat = currentView === 'chat';
            historyList.querySelectorAll('.history-item').forEach(function (item) {
                item.classList.toggle('active', isChat && item.dataset.id === currentSessionId);
            });
            projectList.querySelectorAll('.project-item').forEach(function (item) {
                item.classList.toggle('active', isChat && item.dataset.id === activeProjectId);
            });
            projectList.querySelectorAll('.project-session-item').forEach(function (item) {
                item.classList.toggle('active', isChat && item.dataset.id === currentSessionId);
            });
        }

        function revealSessionContainer(projectId) {
            if (projectId) {
                isProjectsCollapsed = false;
                localStorage.setItem('projectsCollapsed', 'false');
                expandedProjectIds.add(projectId);
                saveStoredSet('expandedProjectIds', expandedProjectIds);
                updateProjectsCollapsedState();
            } else {
                isHistoryCollapsed = false;
                localStorage.setItem('historyCollapsed', 'false');
                updateHistoryCollapsedState();
            }
        }

        function revealActiveSessionInSidebar() {
            if (!currentSessionId) return;
            var container = currentSessionProjectId ? projectList : historyList;
            var items = container.querySelectorAll('[data-id]');
            for (var i = 0; i < items.length; i++) {
                if (items[i].dataset.id === currentSessionId) {
                    items[i].scrollIntoView({ block: 'nearest' });
                    return;
                }
            }
        }

        async function fetchSessions() {
            try {
                var res = await fetch('/api/sessions');
                sessions = await res.json();
                renderHistory();
                renderProjects();
            } catch (e) {
                console.error('Failed to fetch sessions:', e);
            }
        }

        async function fetchProjects() {
            try {
                var res = await fetch('/api/projects');
                projects = await res.json();
                renderProjects();
            } catch (e) {
                console.error('Failed to fetch projects:', e);
            }
        }

        async function refreshSidebarDirectory() {
            if (isSidebarRefreshInFlight) return;
            isSidebarRefreshInFlight = true;
            try {
                await Promise.all([fetchProjects(), fetchSessions()]);
                updateSidebarSelection();
            } finally {
                isSidebarRefreshInFlight = false;
            }
        }

        function startSidebarAutoRefresh() {
            if (sidebarRefreshTimer) clearInterval(sidebarRefreshTimer);
            sidebarRefreshTimer = setInterval(function () {
                if (document.hidden) return;
                refreshSidebarDirectory();
            }, SIDEBAR_REFRESH_INTERVAL_MS);
        }

        document.addEventListener('visibilitychange', function () {
            if (document.hidden) return;
            refreshSidebarDirectory();
        });

        window.addEventListener('beforeunload', function () {
            if (sidebarRefreshTimer) clearInterval(sidebarRefreshTimer);
        });

        async function addProject() {
            try {
                addProjectBtn.disabled = true;
                var res = await fetch('/api/projects/pick', { method: 'POST' });
                var data = await res.json();
                if (!res.ok) throw new Error(data.error || '添加项目失败');
                if (data.canceled) return;
                activeProjectId = data.id;
                expandedProjectIds.add(data.id);
                saveStoredSet('expandedProjectIds', expandedProjectIds);
                await Promise.all([fetchProjects(), fetchSessions()]);
                selectProject(data.id);
            } catch (e) {
                showError(e.message || '添加项目失败');
            } finally {
                addProjectBtn.disabled = false;
            }
        }

        async function createNewChat(projectId, options) {
            options = options || {};
            var targetProjectId = arguments.length > 0 ? projectId : activeProjectId;
            if (!targetProjectId) targetProjectId = null;
            if (currentView !== 'chat') {
                showChatView();
            }
            var currentProviderType = providerData && providerData.current;
            var canReuseEmptySession =
                !options.force &&
                currentSessionId &&
                currentSessionProjectId === targetProjectId &&
                (!currentProviderType || currentSessionProvider === currentProviderType) &&
                !document.querySelector('#messages .message-row');
            if (canReuseEmptySession) {
                activeProjectId = targetProjectId;
                revealSessionContainer(targetProjectId);
                renderHistory();
                renderProjects();
                updateSidebarSelection();
                revealActiveSessionInSidebar();
                inputEl.focus();
                return;
            }
            try {
                var res = await fetch('/api/sessions', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({ projectId: targetProjectId }),
                });
                var data = await res.json();
                if (!res.ok) throw new Error(data.error || '创建会话失败');
                currentSessionId = data.id;
                currentSessionProjectId = data.projectId || targetProjectId || null;
                currentSessionProvider = data.provider || null;
                activeProjectId = currentSessionProjectId;
                revealSessionContainer(currentSessionProjectId);
                showChatView();
                updateContextUsage(null);
                showEmptyState();
                inputEl.value = '';
                resizeChatInput();
                sendBtn.disabled = true;
                inputEl.focus();
                await fetchModelConfig(currentSessionProvider);
                await fetchSessions();
                updateSidebarSelection();
                revealActiveSessionInSidebar();
            } catch (e) {
                showError(e.message || '创建会话失败');
            }
        }

        function stopActiveStreamSubscription() {
            if (activeStreamAbortController) {
                activeStreamAbortController.abort();
                activeStreamAbortController = null;
            }
            activeStreamSessionId = null;
            isTyping = false;
            isCancellingResponse = false;
            updateSendBtnState();
        }

        async function cancelCurrentResponse() {
            var targetSessionId = activeStreamSessionId || currentSessionId;
            if (!targetSessionId || isCancellingResponse) return;

            isCancellingResponse = true;
            updateSendBtnState();
            try {
                var res = await fetch('/api/sessions/' + targetSessionId + '/messages/cancel', {
                    method: 'POST',
                });
                if (!res.ok) {
                    var err = await res.json().catch(function () {
                        return {};
                    });
                    throw new Error(err.error || '中断失败');
                }
            } catch (e) {
                isCancellingResponse = false;
                updateSendBtnState();
                showError(e.message || '中断失败');
            }
        }

        async function resumeActiveStream(sessionId, activeStream) {
            if (!window.ClaudeAgentLoop || !window.ClaudeAgentLoop.resume) return;

            var controller = new AbortController();
            activeStreamAbortController = controller;
            activeStreamSessionId = sessionId;
            isTyping = true;
            isCancellingResponse = false;
            updateSendBtnState();

            var agentView = window.ClaudeAgentLoop.createMessage({
                messagesEl: messagesEl,
                scrollBottom: scrollBottom,
                startedAt: activeStream && activeStream.startedAt,
            });

            try {
                var result = await window.ClaudeAgentLoop.resume({
                    sessionId: sessionId,
                    view: agentView,
                    signal: controller.signal,
                    onContextUsage: updateContextUsage,
                });

                if (activeStreamSessionId !== sessionId) return;

                if (result && result.inactive) {
                    if (agentView.row) agentView.row.remove();
                    stopActiveStreamSubscription();
                    isTyping = false;
                    isCancellingResponse = false;
                    updateSendBtnState();
                    await loadSession(sessionId);
                    return;
                }

                await fetchSessions();
            } catch (e) {
                if (e.name === 'AbortError') return;
                if (agentView) {
                    agentView.handleEvent({
                        type: 'error',
                        error: e.message || '网络错误，请检查连接',
                    });
                }
                showError(e.message || '网络错误，请检查连接');
            } finally {
                if (activeStreamSessionId === sessionId) {
                    activeStreamAbortController = null;
                    activeStreamSessionId = null;
                    isTyping = false;
                    isCancellingResponse = false;
                    updateSendBtnState();
                }
            }
        }

        async function loadSession(id) {
            if (id === currentSessionId && currentView === 'chat') {
                inputEl.focus();
                return;
            }

            try {
                stopActiveStreamSubscription();
                var res = await fetch('/api/sessions/' + id + '?limit=' + SESSION_MESSAGE_PAGE_SIZE);
                if (!res.ok) {
                    showError('加载会话失败');
                    return;
                }
                var data = await res.json();
                var wasChatView = currentView === 'chat';
                currentSessionId = id;
                currentSessionProjectId = data.projectId || null;
                currentSessionProvider = data.provider || null;
                activeProjectId = data.projectId || null;
                currentSessionHasMoreMessages = !!data.hasMoreMessages;
                isLoadingOlderMessages = false;
                updateContextUsage(null);
                var didExpandProject = false;
                if (activeProjectId && !expandedProjectIds.has(activeProjectId)) {
                    expandedProjectIds.add(activeProjectId);
                    saveStoredSet('expandedProjectIds', expandedProjectIds);
                    didExpandProject = true;
                }

                if (!wasChatView) showChatView();

                messagesEl.innerHTML = '';
                isBatchRenderingMessages = true;
                try {
                    if (data.messages.length === 0) {
                        showEmptyState();
                    } else {
                        data.messages.forEach(function (m) {
                            renderMessageRecord(m);
                        });
                    }
                } finally {
                    isBatchRenderingMessages = false;
                }
                renderOlderMessagesControl();
                scrollBottom();
                await fetchModelConfig(currentSessionProvider);

                if (data.activeStream) {
                    resumeActiveStream(id, data.activeStream);
                }

                if (wasChatView && didExpandProject) renderProjects();
                updateSidebarSelection();
                inputEl.focus();
            } catch (e) {
                showError('加载会话失败');
            }
        }

        async function deleteSession(id) {
            try {
                await fetch('/api/sessions/' + id, {method: 'DELETE'});
                if (currentSessionId === id) {
                    currentSessionId = null;
                    currentSessionProjectId = null;
                    currentSessionProvider = null;
                    updateContextUsage(null);
                    showEmptyState();
                }
                await fetchSessions();
            } catch (e) {
                showError('删除失败');
            }
        }

        async function sendMessage() {
            var text = inputEl.value.trim();
            // 收集已上传完成的附件
            var readyAttachments = pendingAttachments.filter(function (a) { return !a.uploading && a.path; });
            if ((!text && readyAttachments.length === 0) || isTyping || !currentSessionId) return;
            var requestSessionId = currentSessionId;

            // 收集附件信息用于显示（包含 path 以便渲染图片）
            var attachmentInfos = readyAttachments.map(function (a) { return { name: a.name, path: a.path }; });

            inputEl.value = '';
            resizeChatInput();
            sendBtn.disabled = true;
            isTyping = true;
            isCancellingResponse = false;
            updateSendBtnState();

            // 清空附件预览
            pendingAttachments = [];
            renderAttachmentPreview();

            appendMessage('user', text || '[附件]', attachmentInfos);
            showTyping();

            // 构建请求体
            var body = { content: text };
            if (readyAttachments.length > 0) {
                body.attachments = readyAttachments.map(function (a) {
                    return { path: a.path, name: a.name };
                });
            }

            var agentView = null;
            try {
                if (window.ClaudeAgentLoop && window.ClaudeAgentLoop.canStream(currentSessionProvider || (providerData && providerData.current))) {
                    removeTyping();
                    agentView = window.ClaudeAgentLoop.createMessage({
                        messagesEl: messagesEl,
                        scrollBottom: scrollBottom,
                    });
                    var streamController = new AbortController();
                    activeStreamAbortController = streamController;
                    activeStreamSessionId = requestSessionId;
                    var streamResult = await window.ClaudeAgentLoop.stream({
                        sessionId: requestSessionId,
                        body: body,
                        view: agentView,
                        signal: streamController.signal,
                        onContextUsage: updateContextUsage,
                    });
                    if (activeStreamSessionId === requestSessionId) {
                        activeStreamAbortController = null;
                        activeStreamSessionId = null;
                    }
                    if (!streamResult.fallback) {
                        if (streamResult.result && streamResult.result.provider) {
                            currentSessionProvider = streamResult.result.provider;
                        }
                        await fetchSessions();
                        isTyping = false;
                        isCancellingResponse = false;
                        updateSendBtnState();
                        return;
                    }
                    if (agentView && agentView.row) agentView.row.remove();
                    agentView = null;
                    showTyping();
                }

                var res = await fetch('/api/sessions/' + requestSessionId + '/messages', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify(body),
                });

                removeTyping();

                if (!res.ok) {
                    var err = await res.json().catch(function () {
                        return {};
                    });
                    showError(err.error || '发送失败，请重试');
                    isTyping = false;
                    isCancellingResponse = false;
                    return;
                }

                var data = await res.json();
                if (data.provider) currentSessionProvider = data.provider;
                if (data.contextUsage) updateContextUsage(data.contextUsage);
                appendMessage('ai', data.content, null, data.changeReview);

                await fetchSessions();
            } catch (e) {
                removeTyping();
                if (activeStreamSessionId === requestSessionId) {
                    activeStreamAbortController = null;
                    activeStreamSessionId = null;
                }
                if (e.name === 'AbortError') {
                    // 切换会话时只断开本页订阅，不取消后台任务。
                } else if (agentView) {
                    agentView.handleEvent({
                        type: 'error',
                        error: e.message || '网络错误，请检查连接',
                    });
                    showError(e.message || '网络错误，请检查连接');
                } else {
                    showError(e.message || '网络错误，请检查连接');
                }
            }

            isTyping = false;
            isCancellingResponse = false;
            updateSendBtnState();
        }

        function getModelConfigProvider() {
            return (modelConfig && modelConfig.provider) || currentSessionProvider || (providerData && providerData.current) || '';
        }

        function updateModelBadgeLabel() {
            if (!modelConfig) return;
            currentModelNameEl.textContent = modelConfig.currentModel;
            modelBadge.title = currentModelNameEl.textContent;
        }

        async function fetchModelConfig(providerType) {
            try {
                var targetProvider = providerType || currentSessionProvider || '';
                var url = '/api/model-config' + (targetProvider ? '?provider=' + encodeURIComponent(targetProvider) : '');
                var res = await fetch(url);
                modelConfig = await res.json();
                updateModelBadgeLabel();
                renderModelDropdown();
            } catch (e) {
                currentModelNameEl.textContent = 'error';
                console.error('Failed to fetch model config:', e);
            }
        }

        function renderModelDropdown() {
            if (!modelConfig) return;
            modelDropdown.innerHTML = '';
            modelConfig.models.forEach(function (m) {
                var opt = document.createElement('div');
                opt.className = 'model-option' + (m.id === modelConfig.currentModel ? ' active' : '');
                opt.innerHTML =
                    '<div class="model-option-name">' +
                    (m.id === modelConfig.currentModel
                        ? '<svg class="model-option-check" viewBox="0 0 14 14" fill="none"><path d="M2.5 7.5l3 3 6-7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>'
                        : '<span style="width:14px;display:inline-block"></span>') +
                    escapeHtml(m.id) +
                    '</div>' +
                    '<div class="model-option-desc">' + escapeHtml(m.description) + '</div>';
                opt.addEventListener('click', function (e) {
                    e.stopPropagation();
                    switchModel(m.id);
                });
                modelDropdown.appendChild(opt);
            });
        }

        async function switchModel(modelId) {
            if (!modelConfig || modelId === modelConfig.currentModel) {
                modelSwitcher.classList.remove('open');
                modelBadge.setAttribute('aria-expanded', 'false');
                return;
            }
            try {
                var res = await fetch('/api/model-config', {
                    method: 'PUT',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({modelId: modelId, provider: getModelConfigProvider()}),
                });
                if (!res.ok) {
                    var err = await res.json().catch(function () {
                        return {};
                    });
                    showError(err.error || '切换模型失败');
                    return;
                }
                modelConfig = await res.json();
                updateModelBadgeLabel();
                renderModelDropdown();
                modelSwitcher.classList.remove('open');
                modelBadge.setAttribute('aria-expanded', 'false');
            } catch (e) {
                showError('切换模型失败');
            }
        }

        modelBadge.addEventListener('click', function (e) {
            e.stopPropagation();
            var isOpen = modelSwitcher.classList.toggle('open');
            modelBadge.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
        });

        const SETTINGS_TAB_META = {
            general: ['常规', '外观主题和默认权限'],
            network: ['网络', '代理服务器和出站连接配置'],
            provider: ['提供商', '提供商配置'],
            workspace: ['工作区', '默认工作目录和项目入口'],
            privacy: ['隐私与日志', '日志目录和清理操作'],
        };

        function createDefaultAppSettings() {
            return {
                general: {
                    theme: 'system',
                    language: 'auto',
                    openAtLogin: false,
                    openWindowOnStart: true,
                    webPort: 19981,
                },
                providers: {},
                workspace: {
                    defaultWorkdir: '',
                },
                permissions: {
                    requireDangerousConfirmation: true,
                },
                privacy: {
                    logLevel: 'info',
                    logIncludeContent: false,
                    logIncludePrompt: false,
                },
            };
        }

        function mergeAppSettings(raw) {
            var base = createDefaultAppSettings();
            raw = raw || {};
            return {
                general: Object.assign({}, base.general, raw.general || {}),
                providers: Object.assign({}, base.providers, raw.providers || {}),
                workspace: Object.assign({}, base.workspace, raw.workspace || {}),
                permissions: Object.assign({}, base.permissions, raw.permissions || {}),
                privacy: Object.assign({}, base.privacy, raw.privacy || {}),
            };
        }

        function showSettingsStatus(message, tone) {
            if (!settingsSaveStatus) return;
            settingsSaveStatus.textContent = message || '';
            settingsSaveStatus.style.color = tone === 'error' ? '#fb7185' : '';
            clearTimeout(settingsSaveStatus._timer);
            if (message) {
                settingsSaveStatus._timer = setTimeout(function () {
                    settingsSaveStatus.textContent = '';
                    settingsSaveStatus.style.color = '';
                }, 2600);
            }
        }

        async function persistAppSettingsPatch(patch, successMessage) {
            try {
                var res = await fetch('/api/app-settings', {
                    method: 'PUT',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify(patch),
                });
                if (!res.ok) {
                    var err = await res.json().catch(function () { return {}; });
                    showError(err.error || '保存设置失败');
                    return false;
                }
                appSettingsPayload = await res.json();
                appSettings = mergeAppSettings(appSettingsPayload.settings);
                var migratedCount = Array.isArray(appSettingsPayload.migratedMemoryFiles)
                    ? appSettingsPayload.migratedMemoryFiles.length
                    : 0;
                showSettingsStatus(migratedCount > 0 ? '已保存，已复制 ' + migratedCount + ' 个记忆文件' : (successMessage || '已保存'));
                return true;
            } catch (e) {
                showError('保存设置失败');
                return false;
            }
        }

        async function fetchAppSettings() {
            try {
                var res = await fetch('/api/app-settings');
                appSettingsPayload = await res.json();
                appSettings = mergeAppSettings(appSettingsPayload.settings);
                renderAppSettings();
            } catch (e) {
                console.error('Failed to fetch app settings:', e);
                appSettings = createDefaultAppSettings();
                renderAppSettings();
            }
        }

        function renderAppSettings() {
            if (!appSettings) return;
            setTheme(appSettings.general.theme || currentThemeSetting || 'system');
            if (settingsDefaultWorkdir) {
                settingsDefaultWorkdir.value =
                    appSettings.workspace.defaultWorkdir ||
                    (appSettingsPayload && appSettingsPayload.effective && appSettingsPayload.effective.workdir) ||
                    '';
            }
            renderNetworkSettings();
            renderSettingsProviderDetails();
        }

        function setSettingsTab(tab) {
            if (!SETTINGS_TAB_META[tab]) tab = 'general';
            activeSettingsTab = tab;
            settingsNavItems.forEach(function (item) {
                var active = item.dataset.settingsTab === tab;
                item.classList.toggle('active', active);
                item.setAttribute('aria-selected', active ? 'true' : 'false');
            });
            settingsTabPanels.forEach(function (panel) {
                panel.classList.toggle('active', panel.dataset.settingsPanel === tab);
            });
            if (settingsTitle) settingsTitle.textContent = SETTINGS_TAB_META[tab][0];
            if (settingsSubtitle) settingsSubtitle.textContent = SETTINGS_TAB_META[tab][1];
            if (tab === 'network') renderNetworkSettings();
        }

        settingsNavItems.forEach(function (item) {
            item.addEventListener('click', function () {
                setSettingsTab(item.dataset.settingsTab);
            });
        });

        function getSelectedSettingsProvider() {
            if (!providerData || !settingsProviderSelect) return null;
            return providerData.providers.find(function (p) {
                return p.type === settingsProviderSelect.value;
            }) || null;
        }

        async function fetchSettingsModelConfig(providerType) {
            if (!providerType || !settingsProviderModelSelect) return;
            try {
                var res = await fetch('/api/model-config?provider=' + encodeURIComponent(providerType));
                if (!res.ok) return;
                settingsModelConfig = await res.json();
                renderSettingsModelSelect();
            } catch (e) {
                console.error('Failed to fetch settings model config:', e);
            }
        }

        function renderSettingsModelSelect() {
            if (!settingsProviderModelSelect) return;
            settingsProviderModelSelect.innerHTML = '';
            if (!settingsModelConfig || !Array.isArray(settingsModelConfig.models)) {
                settingsProviderModelSelect.disabled = true;
                return;
            }
            settingsProviderModelSelect.disabled = false;
            settingsModelConfig.models.forEach(function (model) {
                var option = document.createElement('option');
                option.value = model.id;
                option.textContent = model.name || model.id;
                settingsProviderModelSelect.appendChild(option);
            });
            settingsProviderModelSelect.value = settingsModelConfig.currentModel || settingsProviderModelSelect.value;
        }

        function getProviderSettings(providerType) {
            if (!appSettings) appSettings = createDefaultAppSettings();
            if (!appSettings.providers) appSettings.providers = {};
            if (!appSettings.providers[providerType]) appSettings.providers[providerType] = {};
            return appSettings.providers[providerType];
        }

        function renderSettingsProviderDetails() {
            var provider = getSelectedSettingsProvider();
            if (!provider || !appSettings) return;
            var cfg = getProviderSettings(provider.type);
            if (settingsProviderStatus) {
                settingsProviderStatus.className = 'provider-status ' + (provider.installed === false ? 'warn' : 'ok');
                settingsProviderStatus.textContent = provider.installed === false
                    ? '未检测到 ' + (provider.bin || provider.displayName) + '。' + (provider.installHint || '')
                    : '已检测到：' + (provider.executablePath || provider.bin || provider.displayName);
            }
            if (settingsProviderBinFields) {
                var binValue = cfg.bin || cfg.pathToClaudeCodeExecutable || '';
                settingsProviderBinFields.innerHTML =
                    '<label class="settings-row">' +
                    '<span><strong>CLI 路径</strong><small>留空时使用默认命令或内置运行时</small></span>' +
                    '<input class="settings-inline-input" id="settings-provider-bin-input" type="text" value="' + escapeHtml(binValue) + '" placeholder="' + escapeHtml(provider.bin || provider.type) + '" spellcheck="false">' +
                    '</label>';
            }
            if (settingsProviderExtraFields) {
                settingsProviderExtraFields.innerHTML = buildProviderExtraFields(provider.type, cfg);
            }
            fetchSettingsModelConfig(provider.type);
        }

        function buildProviderExtraFields(providerType, cfg) {
            if (providerType === 'gemini-cli') {
                var approval = cfg.approvalMode || 'yolo';
                return '<label class="settings-row"><span><strong>Approval Mode</strong><small>Gemini CLI 操作审批方式</small></span>' +
                    '<select class="settings-inline-select" id="settings-provider-approval">' +
                    '<option value="yolo"' + (approval === 'yolo' ? ' selected' : '') + '>yolo</option>' +
                    '<option value="auto-edit"' + (approval === 'auto-edit' ? ' selected' : '') + '>auto-edit</option>' +
                    '<option value="confirm"' + (approval === 'confirm' ? ' selected' : '') + '>confirm</option>' +
                    '</select></label>';
            }
            if (providerType === 'cursor-cli') {
                return '<label class="settings-row"><span><strong>Workspace</strong><small>Cursor CLI 默认 workspace</small></span>' +
                    '<input class="settings-inline-input" id="settings-provider-workspace" value="' + escapeHtml(cfg.workspace || '') + '" spellcheck="false"></label>' +
                    '<label class="settings-row"><span><strong>API Key</strong><small>仅在需要 Cursor API Key 时填写</small></span>' +
                    '<input class="settings-inline-input" id="settings-provider-api-key" type="password" value="' + escapeHtml(cfg.apiKey || '') + '"></label>';
            }
            if (providerType === 'qoder-cli') {
                return '<label class="settings-row"><span><strong>Max Turns</strong><small>Qoder CLI 最大轮数</small></span>' +
                    '<input class="settings-inline-input short" id="settings-provider-max-turns" type="number" min="1" value="' + escapeHtml(String(cfg.maxTurns || '')) + '"></label>';
            }
            if (providerType === 'claude-code') {
                var permission = cfg.permissionMode || '';
                return '<label class="settings-row"><span><strong>Max Turns</strong><small>Claude Code 最大轮数</small></span>' +
                    '<input class="settings-inline-input short" id="settings-provider-max-turns" type="number" min="1" value="' + escapeHtml(String(cfg.maxTurns || '')) + '"></label>' +
                    '<label class="settings-row"><span><strong>Permission Mode</strong><small>留空则按默认 Sandbox 映射</small></span>' +
                    '<select class="settings-inline-select" id="settings-provider-permission">' +
                    '<option value=""' + (!permission ? ' selected' : '') + '>自动</option>' +
                    '<option value="default"' + (permission === 'default' ? ' selected' : '') + '>default</option>' +
                    '<option value="acceptEdits"' + (permission === 'acceptEdits' ? ' selected' : '') + '>acceptEdits</option>' +
                    '<option value="bypassPermissions"' + (permission === 'bypassPermissions' ? ' selected' : '') + '>bypassPermissions</option>' +
                    '</select></label>';
            }
            return '<div class="provider-status">当前提供商没有额外参数。</div>';
        }

        function collectProviderSettings(providerType) {
            var current = getProviderSettings(providerType);
            var next = Object.assign({}, current);
            var binInput = document.getElementById('settings-provider-bin-input');
            var approvalInput = document.getElementById('settings-provider-approval');
            var workspaceInput = document.getElementById('settings-provider-workspace');
            var apiKeyInput = document.getElementById('settings-provider-api-key');
            var maxTurnsInput = document.getElementById('settings-provider-max-turns');
            var permissionInput = document.getElementById('settings-provider-permission');
            if (binInput) next.bin = binInput.value.trim();
            if (approvalInput) next.approvalMode = approvalInput.value;
            if (workspaceInput) next.workspace = workspaceInput.value.trim();
            if (apiKeyInput) next.apiKey = apiKeyInput.value;
            if (maxTurnsInput) {
                var maxTurns = parseInt(maxTurnsInput.value, 10);
                if (Number.isFinite(maxTurns) && maxTurns > 0) next.maxTurns = maxTurns;
                else delete next.maxTurns;
            }
            if (permissionInput) next.permissionMode = permissionInput.value;
            Object.keys(next).forEach(function (key) {
                if (next[key] === '') delete next[key];
            });
            return next;
        }

        if (settingsProviderTrigger) {
            settingsProviderTrigger.addEventListener('click', function (e) {
                e.stopPropagation();
                setSettingsProviderMenuOpen(!settingsProviderCombobox.classList.contains('open'));
            });
            settingsProviderTrigger.addEventListener('keydown', function (e) {
                if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    setSettingsProviderMenuOpen(true);
                } else if (e.key === 'ArrowUp') {
                    e.preventDefault();
                    setSettingsProviderMenuOpen(true);
                    requestAnimationFrame(function () {
                        var options = getSettingsProviderOptions();
                        var last = options[options.length - 1];
                        if (last) last.focus();
                    });
                } else if (e.key === 'Escape') {
                    setSettingsProviderMenuOpen(false);
                }
            });
        }

        if (settingsProviderMenu) {
            settingsProviderMenu.addEventListener('click', function (e) {
                e.stopPropagation();
            });
        }

        async function fetchProviders() {
            try {
                var res = await fetch('/api/providers');
                providerData = await res.json();
                renderProviderSelect();
                updateModelBadgeLabel();
            } catch (e) {
                console.error('Failed to fetch providers:', e);
            }
        }

        async function fetchSandboxConfig() {
            try {
                var res = await fetch('/api/sandbox-config');
                sandboxConfig = await res.json();
                selectedSandbox = sandboxConfig.defaultSandbox;
                renderSandboxOptions();
            } catch (e) {
                console.error('Failed to fetch sandbox config:', e);
            }
        }

        function renderSandboxOptions() {
            if (!settingsSandboxGroup || !sandboxConfig) return;
            settingsSandboxGroup.innerHTML = '';
            sandboxConfig.modes.forEach(function (mode) {
                var button = document.createElement('button');
                var isActive = mode.id === selectedSandbox;
                button.className = 'sandbox-option' + (isActive ? ' active' : '');
                button.type = 'button';
                button.setAttribute('role', 'radio');
                button.setAttribute('aria-checked', isActive ? 'true' : 'false');
                button.dataset.sandboxValue = mode.id;
                button.innerHTML =
                    '<span class="sandbox-option-name">' + escapeHtml(mode.name) + '</span>' +
                    '<span class="sandbox-option-desc">' + escapeHtml(mode.description) + '</span>';
                button.addEventListener('click', async function () {
                    if (setSettingsSandboxValue(mode.id)) {
                        await persistSandboxConfig();
                        showSettingsStatus('已保存');
                    }
                });
                settingsSandboxGroup.appendChild(button);
            });
        }

        function setSettingsSandboxValue(sandbox) {
            if (!sandboxConfig || !settingsSandboxGroup) return false;
            var valid = sandboxConfig.modes.some(function (mode) {
                return mode.id === sandbox;
            });
            if (!valid) {
                showError('该权限模式不可用');
                return false;
            }
            selectedSandbox = sandbox;
            Array.prototype.forEach.call(settingsSandboxGroup.querySelectorAll('.sandbox-option'), function (button) {
                var isActive = button.dataset.sandboxValue === selectedSandbox;
                button.classList.toggle('active', isActive);
                button.setAttribute('aria-checked', isActive ? 'true' : 'false');
            });
            return true;
        }

        async function persistSandboxConfig() {
            if (!sandboxConfig || !selectedSandbox || selectedSandbox === sandboxConfig.defaultSandbox) return true;
            try {
                var res = await fetch('/api/sandbox-config', {
                    method: 'PUT',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({defaultSandbox: selectedSandbox}),
                });
                if (!res.ok) {
                    var err = await res.json().catch(function () { return {}; });
                    showError(err.error || '保存权限配置失败');
                    return false;
                }
                sandboxConfig = await res.json();
                selectedSandbox = sandboxConfig.defaultSandbox;
                renderSandboxOptions();
                return true;
            } catch (e) {
                showError('保存权限配置失败');
                return false;
            }
        }

        function renderProviderSelect() {
            if (!providerData || !settingsProviderSelect) return;
            settingsProviderSelect.innerHTML = '';
            if (settingsProviderMenu) settingsProviderMenu.innerHTML = '';
            providerData.providers.forEach(function (p) {
                var isInstalled = isProviderInstalled(p);
                var opt = document.createElement('option');
                opt.value = p.type;
                opt.textContent = p.displayName + (isInstalled ? '' : '（未安装）');
                opt.disabled = !isInstalled;
                settingsProviderSelect.appendChild(opt);

                if (settingsProviderMenu) {
                    var item = document.createElement('button');
                    item.className = 'settings-combobox-option';
                    item.type = 'button';
                    item.setAttribute('role', 'option');
                    item.disabled = !isInstalled;
                    item.setAttribute('aria-disabled', isInstalled ? 'false' : 'true');
                    if (!isInstalled) item.title = (p.bin || p.displayName) + ' 未安装';
                    item.dataset.providerType = p.type;
                    item.dataset.providerDisplayName = p.displayName;
                    item.dataset.providerInstalled = isInstalled ? 'true' : 'false';
                    item.dataset.providerBin = p.bin || '';
                    item.innerHTML = buildSettingsProviderOptionHtml(false, p.displayName, !isInstalled);
                    item.addEventListener('click', async function (e) {
                        e.stopPropagation();
                        if (setSettingsProviderValue(p.type)) {
                            setSettingsProviderMenuOpen(false);
                            settingsProviderTrigger.focus();
                            await persistSettingsProviderSelection(p.type);
                        }
                    });
                    item.addEventListener('keydown', handleSettingsProviderOptionKeydown);
                    settingsProviderMenu.appendChild(item);
                }
            });
            settingsProviderSelect.value = providerData.current;
            updateSettingsProviderDisplay();
            renderSettingsProviderDetails();
        }

        function isProviderInstalled(provider) {
            return !provider || provider.installed !== false;
        }

        function isSettingsProviderSelectable(providerType) {
            if (!providerData) return false;
            var provider = providerData.providers.find(function (p) {
                return p.type === providerType;
            });
            return !!provider && isProviderInstalled(provider);
        }

        function buildSettingsProviderOptionHtml(isActive, displayName, isDisabled) {
            return (
                isActive
                    ? '<svg class="settings-combobox-check" viewBox="0 0 14 14" fill="none" aria-hidden="true"><path d="M2.5 7.5l3 3 6-7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>'
                    : '<span class="settings-combobox-check-placeholder"></span>'
            ) +
                '<span class="settings-combobox-option-label">' + escapeHtml(displayName || '') + '</span>' +
                (isDisabled ? '<span class="settings-combobox-option-status">未安装</span>' : '');
        }

        function getSettingsProviderOptions(includeDisabled) {
            if (!settingsProviderMenu) return [];
            var options = Array.prototype.slice.call(settingsProviderMenu.querySelectorAll('.settings-combobox-option'));
            if (includeDisabled) return options;
            return options.filter(function (item) { return !item.disabled; });
        }

        function updateSettingsProviderDisplay() {
            if (!providerData || !settingsProviderSelect) return;
            var selected = providerData.providers.find(function (p) {
                return p.type === settingsProviderSelect.value;
            });
            if (settingsProviderCurrent) {
                settingsProviderCurrent.textContent = selected
                    ? selected.displayName + (isProviderInstalled(selected) ? '' : '（未安装）')
                    : '请选择提供商';
            }
            getSettingsProviderOptions(true).forEach(function (item) {
                var isActive = item.dataset.providerType === settingsProviderSelect.value;
                var isDisabled = item.dataset.providerInstalled === 'false';
                item.classList.toggle('active', isActive);
                item.classList.toggle('disabled', isDisabled);
                item.disabled = isDisabled;
                item.setAttribute('aria-disabled', isDisabled ? 'true' : 'false');
                item.setAttribute('aria-selected', isActive ? 'true' : 'false');
                item.innerHTML = buildSettingsProviderOptionHtml(
                    isActive,
                    item.dataset.providerDisplayName || '',
                    isDisabled,
                );
            });
        }

        function setSettingsProviderValue(providerType) {
            if (!settingsProviderSelect) return false;
            if (!isSettingsProviderSelectable(providerType)) {
                showError('该提供商未安装，无法选择');
                return false;
            }
            settingsProviderSelect.value = providerType;
            updateSettingsProviderDisplay();
            renderSettingsProviderDetails();
            return true;
        }

        function setSettingsProviderMenuOpen(isOpen) {
            if (!settingsProviderCombobox || !settingsProviderTrigger) return;
            settingsProviderCombobox.classList.toggle('open', isOpen);
            settingsProviderTrigger.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
            if (isOpen) {
                var active = settingsProviderMenu && settingsProviderMenu.querySelector('.settings-combobox-option.active:not(:disabled)');
                requestAnimationFrame(function () {
                    (active || getSettingsProviderOptions()[0] || settingsProviderTrigger).focus();
                });
            }
        }

        function moveSettingsProviderFocus(delta) {
            var options = getSettingsProviderOptions();
            if (!options.length) return;
            var currentIndex = options.indexOf(document.activeElement);
            var nextIndex = currentIndex < 0 ? 0 : (currentIndex + delta + options.length) % options.length;
            options[nextIndex].focus();
        }

        function handleSettingsProviderOptionKeydown(e) {
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                moveSettingsProviderFocus(1);
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                moveSettingsProviderFocus(-1);
            } else if (e.key === 'Home') {
                e.preventDefault();
                var first = getSettingsProviderOptions()[0];
                if (first) first.focus();
            } else if (e.key === 'End') {
                e.preventDefault();
                var options = getSettingsProviderOptions();
                var last = options[options.length - 1];
                if (last) last.focus();
            } else if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                var providerType = e.currentTarget.dataset.providerType;
                if (setSettingsProviderValue(providerType)) {
                    setSettingsProviderMenuOpen(false);
                    settingsProviderTrigger.focus();
                    persistSettingsProviderSelection(providerType);
                }
            } else if (e.key === 'Escape') {
                e.preventDefault();
                setSettingsProviderMenuOpen(false);
                settingsProviderTrigger.focus();
            }
        }

        function openSettingsPanel() {
            hideAllViews();
            currentView = 'settings';
            setSettingsTab(activeSettingsTab || 'general');
            if (appSettings) renderAppSettings();
            if (providerData) renderProviderSelect();
            if (sandboxConfig) {
                selectedSandbox = sandboxConfig.defaultSandbox;
                renderSandboxOptions();
            }
            settingsView.style.display = 'flex';
            settingsBtn.classList.add('active');
            modelSwitcher.classList.remove('open');
            modelBadge.setAttribute('aria-expanded', 'false');
            requestAnimationFrame(function () {
                var activeNav = document.querySelector('.settings-nav-item.active');
                if (activeNav) activeNav.focus();
            });
        }

        function closeSettingsPanel() {
            setSettingsProviderMenuOpen(false);
            showChatView();
        }

        var workdirSaveTimer = null;

        function scheduleDefaultWorkdirSave() {
            if (!settingsDefaultWorkdir) return;
            clearTimeout(workdirSaveTimer);
            workdirSaveTimer = setTimeout(function () {
                persistDefaultWorkdir();
            }, 600);
        }

        async function persistDefaultWorkdir() {
            if (!settingsDefaultWorkdir) return false;
            return persistAppSettingsPatch({
                workspace: {
                    defaultWorkdir: settingsDefaultWorkdir.value.trim(),
                },
            }, '已保存');
        }

        async function persistSettingsProviderSelection(providerType) {
            if (!providerType || !isSettingsProviderSelectable(providerType)) return false;
            var saved = await switchProviderTo(providerType, { closeOnSuccess: false });
            if (saved) showSettingsStatus('已保存');
            return saved;
        }

        async function saveSettingsProviderModel(providerType, modelId) {
            try {
                var res = await fetch('/api/model-config', {
                    method: 'PUT',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({provider: providerType, modelId: modelId}),
                });
                if (res.ok && (!currentSessionProvider || currentSessionProvider === providerType)) {
                    modelConfig = await res.json();
                    updateModelBadgeLabel();
                    renderModelDropdown();
                }
            } catch (e) {
                showError('保存默认模型失败');
            }
        }

        async function switchProviderTo(providerType, opts) {
            if (!providerData || (providerType === providerData.current && !(opts && opts.force))) {
                if (opts && opts.closeOnSuccess) closeSettingsPanel();
                return true;
            }
            var shouldClose = !!(opts && opts.closeOnSuccess);
            var originalText = settingsSaveBtn ? settingsSaveBtn.textContent : '';
            if (shouldClose) {
                if (settingsSaveBtn) {
                    settingsSaveBtn.disabled = true;
                    settingsSaveBtn.textContent = '保存中…';
                }
            }
            try {
                var res = await fetch('/api/providers/current', {
                    method: 'PUT',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({provider: providerType}),
                });
                if (!res.ok) {
                    var err = await res.json().catch(function () { return {}; });
                    showError(err.error || '切换 Provider 失败');
                    return false;
                }
                var switchedConfig = await res.json();
                providerData.current = providerType;
                if (!currentSessionProvider || currentSessionProvider === providerType) {
                    modelConfig = switchedConfig;
                    updateModelBadgeLabel();
                } else {
                    await fetchModelConfig(currentSessionProvider);
                }
                renderProviderSelect();
                renderModelDropdown();
                if (shouldClose) closeSettingsPanel();
                return true;
            } catch (e) {
                showError('切换 Provider 失败');
                return false;
            } finally {
                if (shouldClose && settingsSaveBtn) {
                    settingsSaveBtn.disabled = false;
                    settingsSaveBtn.textContent = originalText;
                }
            }
        }

        settingsBtn.addEventListener('click', function (e) {
            e.stopPropagation();
            openSettingsPanel();
        });

        if (settingsCancelBtn) settingsCancelBtn.addEventListener('click', closeSettingsPanel);
        if (settingsProviderDetectBtn) {
            settingsProviderDetectBtn.addEventListener('click', async function () {
                await fetchProviders();
                renderSettingsProviderDetails();
                showSettingsStatus('检测完成');
            });
        }
        if (settingsWorkdirPickBtn) {
            settingsWorkdirPickBtn.addEventListener('click', async function () {
                try {
                    var res = await fetch('/api/app-settings/default-workdir/pick', { method: 'POST' });
                    var data = await res.json();
                    if (data.path && settingsDefaultWorkdir) {
                        settingsDefaultWorkdir.value = data.path;
                        await persistDefaultWorkdir();
                    }
                } catch (e) {
                    showError('选择目录失败');
                }
            });
        }
        if (settingsDefaultWorkdir) {
            settingsDefaultWorkdir.addEventListener('input', scheduleDefaultWorkdirSave);
            settingsDefaultWorkdir.addEventListener('change', persistDefaultWorkdir);
        }
        if (settingsProjectsEntryBtn) {
            settingsProjectsEntryBtn.addEventListener('click', function () {
                closeSettingsPanel();
                isProjectsCollapsed = false;
                localStorage.setItem('projectsCollapsed', 'false');
                updateProjectsCollapsedState();
                if (addProjectBtn) addProjectBtn.focus();
            });
        }
        if (settingsOpenLogsBtn) settingsOpenLogsBtn.addEventListener('click', function () { runSettingsAction('/api/logs/open', 'POST', '已打开日志目录'); });
        if (settingsClearLogsBtn) settingsClearLogsBtn.addEventListener('click', function () {
            if (confirm('确认清空日志？')) runSettingsAction('/api/logs', 'DELETE', '日志已清空');
        });
        if (settingsOpenDataBtn) settingsOpenDataBtn.addEventListener('click', function () { runSettingsAction('/api/data/open', 'POST', '已打开数据目录'); });
        if (settingsClearUploadsBtn) settingsClearUploadsBtn.addEventListener('click', function () {
            if (confirm('确认清理上传临时文件？')) runSettingsAction('/api/data/uploads', 'DELETE', '上传文件已清理');
        });
        if (settingsClearHistoryBtn) settingsClearHistoryBtn.addEventListener('click', async function () {
            if (!confirm('确认清空所有聊天历史？此操作不可撤销。')) return;
            await runSettingsAction('/api/data/history', 'DELETE', '聊天历史已清空');
            await fetchSessions();
            await createNewChat(null, { force: true });
        });
        if (settingsExportDataBtn) settingsExportDataBtn.addEventListener('click', function () {
            window.location.href = '/api/data/export';
        });
        if (settingsImportDataBtn && settingsImportFile) {
            settingsImportDataBtn.addEventListener('click', function () { settingsImportFile.click(); });
            settingsImportFile.addEventListener('change', importSettingsFile);
        }
        var proxyAuthToggle = document.getElementById('proxy-auth-toggle');
        if (proxyAuthToggle) {
            proxyAuthToggle.addEventListener('click', function () {
                var fields = document.getElementById('proxy-auth-fields');
                if (!fields) return;
                var showing = fields.classList.toggle('show');
                this.textContent = showing ? '隐藏认证' : '认证（可选）';
            });
        }
        var proxySaveBtn = document.getElementById('proxy-save-btn');
        if (proxySaveBtn) proxySaveBtn.addEventListener('click', saveProxyConfig);
        var proxyTestBtn = document.getElementById('proxy-test-btn');
        if (proxyTestBtn) proxyTestBtn.addEventListener('click', testProxyConnection);

        async function runSettingsAction(url, method, successMessage) {
            try {
                var res = await fetch(url, { method: method });
                if (!res.ok) {
                    var err = await res.json().catch(function () { return {}; });
                    showError(err.error || '操作失败');
                    return false;
                }
                showSettingsStatus(successMessage || '已完成');
                return true;
            } catch (e) {
                showError('操作失败');
                return false;
            }
        }

        async function importSettingsFile() {
            var file = settingsImportFile.files && settingsImportFile.files[0];
            settingsImportFile.value = '';
            if (!file) return;
            try {
                var text = await file.text();
                var payload = JSON.parse(text);
                var res = await fetch('/api/data/import', {
                    method: 'PUT',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify(payload),
                });
                if (!res.ok) {
                    var err = await res.json().catch(function () { return {}; });
                    showError(err.error || '导入失败');
                    return;
                }
                await Promise.all([fetchAppSettings(), fetchProviders(), fetchSandboxConfig(), fetchModelConfig()]);
                showSettingsStatus('导入完成');
            } catch (e) {
                showError('导入失败，请确认文件格式');
            }
        }

        document.addEventListener('click', function (e) {
            if (!modelSwitcher.contains(e.target)) {
                modelSwitcher.classList.remove('open');
                modelBadge.setAttribute('aria-expanded', 'false');
            }
            if (settingsProviderCombobox && !settingsProviderCombobox.contains(e.target)) {
                setSettingsProviderMenuOpen(false);
            }
        });

        document.addEventListener('keydown', function (e) {
            if (e.key === 'Escape') {
                if (settingsProviderCombobox && settingsProviderCombobox.classList.contains('open')) {
                    setSettingsProviderMenuOpen(false);
                    settingsProviderTrigger.focus();
                    return;
                }
                modelSwitcher.classList.remove('open');
                modelBadge.setAttribute('aria-expanded', 'false');
                if (currentView === 'settings') closeSettingsPanel();
            }
        });

        const chatView = document.getElementById('chat-view');
        const channelView = document.getElementById('channel-view');
        const skillsView = document.getElementById('skills-view');
        const channelsBtn = document.getElementById('channels-btn');
        const skillsBtn = document.getElementById('skills-btn');

        const CHANNEL_META = {
            web: {name: '本地', icon: '本', iconClass: 'web', badge: '本地'},
            feishu: {name: '飞书', icon: '飞', iconClass: 'feishu', badge: '飞书'},
            qqbot: {name: 'QQ', icon: 'Q', iconClass: 'qq', badge: 'QQ'},
            weixin: {name: '微信', icon: '微', iconClass: 'weixin', badge: '微信'},
            dingtalk: {name: '钉钉', icon: '钉', iconClass: 'dingtalk', badge: '钉钉'},
            telegram: {name: 'Telegram', icon: 'T', iconClass: 'telegram', badge: 'TG'},
            discord: {name: 'Discord', icon: 'D', iconClass: 'discord', badge: 'DC'},
        };

        function getChannelMeta(type) {
            return CHANNEL_META[type] || {name: type, icon: type.charAt(0).toUpperCase(), iconClass: 'default'};
        }

        var channelsData = null;
        var skillsData = null;
        var currentView = 'chat';
        var weixinLoginPollTimer = null;

        function hideAllViews() {
            chatView.style.display = 'none';
            channelView.style.display = 'none';
            skillsView.style.display = 'none';
            settingsView.style.display = 'none';
            newChatBtn.classList.remove('active');
            channelsBtn.classList.remove('active');
            skillsBtn.classList.remove('active');
            settingsBtn.classList.remove('active');
        }

        function showChatView() {
            hideAllViews();
            currentView = 'chat';
            chatView.style.display = 'flex';
            newChatBtn.classList.add('active');
            renderHistory();
            renderProjects();
        }

        function showChannelsPage() {
            hideAllViews();
            currentView = 'channels';
            channelView.style.display = 'flex';
            channelsBtn.classList.add('active');
            renderHistory();
            renderAllChannels();
        }

        function showSkillsPage() {
            hideAllViews();
            currentView = 'skills';
            skillsView.style.display = 'flex';
            skillsBtn.classList.add('active');
            renderHistory();
            renderSkillsView();
        }

        channelsBtn.addEventListener('click', function () {
            if (currentView === 'channels') return;
            if (!channelsData) {
                fetchChannels().then(function () {
                    showChannelsPage();
                });
            } else {
                showChannelsPage();
            }
        });

        skillsBtn.addEventListener('click', function () {
            if (currentView === 'skills') return;
            fetchSkills().then(function () {
                showSkillsPage();
            });
        });

        var proxyConfig = null;

        async function fetchProxyConfig() {
            try {
                var res = await fetch('/api/proxy');
                proxyConfig = await res.json();
                renderNetworkSettings();
            } catch (e) {
                console.error('Failed to fetch proxy config:', e);
            }
        }

        function renderNetworkSettings() {
            var cfg = proxyConfig || { enabled: false, protocol: 'http', host: '127.0.0.1', port: 7890 };
            var hasAuth = !!(cfg.username || cfg.password);
            var enabled = document.getElementById('proxy-enabled');
            var protocol = document.getElementById('proxy-protocol');
            var host = document.getElementById('proxy-host');
            var port = document.getElementById('proxy-port');
            var username = document.getElementById('proxy-username');
            var password = document.getElementById('proxy-password');
            var authFields = document.getElementById('proxy-auth-fields');
            var authToggle = document.getElementById('proxy-auth-toggle');
            if (!enabled || !protocol || !host || !port || !username || !password) return;
            enabled.checked = !!cfg.enabled;
            protocol.value = cfg.protocol || 'http';
            host.value = cfg.host || '';
            port.value = cfg.port || '';
            username.value = cfg.username || '';
            password.value = cfg.password || '';
            if (authFields) authFields.classList.toggle('show', hasAuth);
            if (authToggle) authToggle.textContent = hasAuth ? '隐藏认证' : '认证（可选）';
        }

        async function saveProxyConfig() {
            var saveBtn = document.getElementById('proxy-save-btn');
            var statusEl = document.getElementById('proxy-status');
            saveBtn.disabled = true;
            saveBtn.textContent = '保存中…';

            var body = {
                enabled: document.getElementById('proxy-enabled').checked,
                protocol: document.getElementById('proxy-protocol').value,
                host: document.getElementById('proxy-host').value.trim(),
                port: parseInt(document.getElementById('proxy-port').value, 10) || 0,
                username: document.getElementById('proxy-username').value,
                password: document.getElementById('proxy-password').value,
            };

            try {
                var res = await fetch('/api/proxy', {
                    method: 'PUT',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify(body)
                });

                if (!res.ok) {
                    var err = await res.json();
                    throw new Error(err.error || '保存失败');
                }

                proxyConfig = await res.json();
                statusEl.className = 'proxy-status show ' + (body.enabled ? 'success' : 'info');
                statusEl.textContent = body.enabled ? '代理已保存并启用' : '代理配置已保存（未启用）';
            } catch (e) {
                statusEl.className = 'proxy-status show error';
                statusEl.textContent = e.message || '保存失败';
            } finally {
                saveBtn.disabled = false;
                saveBtn.textContent = '保存';
            }
        }

        async function testProxyConnection() {
            var testBtn = document.getElementById('proxy-test-btn');
            var statusEl = document.getElementById('proxy-status');
            testBtn.disabled = true;
            testBtn.textContent = '测试中…';
            statusEl.className = 'proxy-status show info';
            statusEl.textContent = '正在测试代理连接…';

            var body = {
                protocol: document.getElementById('proxy-protocol').value,
                host: document.getElementById('proxy-host').value.trim(),
                port: parseInt(document.getElementById('proxy-port').value, 10) || 0,
                username: document.getElementById('proxy-username').value,
                password: document.getElementById('proxy-password').value,
            };

            try {
                var res = await fetch('/api/proxy/test', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify(body)
                });
                var data = await res.json();

                if (data.ok) {
                    statusEl.className = 'proxy-status show success';
                    statusEl.textContent = '连接成功，延迟 ' + data.latency + 'ms';
                } else {
                    statusEl.className = 'proxy-status show error';
                    statusEl.textContent = '连接失败: ' + (data.error || '未知错误');
                }
            } catch (e) {
                statusEl.className = 'proxy-status show error';
                statusEl.textContent = '测试请求失败: ' + (e.message || '网络错误');
            } finally {
                testBtn.disabled = false;
                testBtn.textContent = '测试连接';
            }
        }

        async function fetchChannels() {
            try {
                var res = await fetch('/api/channels');
                channelsData = await res.json();
            } catch (e) {
                console.error('Failed to fetch channels:', e);
            }
        }

        var openDrawerType = null;

        function renderAllChannels() {
            channelView.innerHTML = '';
            if (!channelsData || !channelsData.registered) return;

            var page = document.createElement('div');
            page.className = 'channel-page';

            var header = document.createElement('div');
            header.className = 'channel-page-header';
            header.innerHTML =
                '<div class="channel-page-header-top">' +
                '<div class="channel-page-header-icon">' +
                '<svg width="20" height="20" viewBox="0 0 14 14" fill="none"><path d="M1.5 5h11M1.5 9h11M5 1.5l-1.5 11M10.5 1.5L9 12.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>' +
                '</div>' +
                '<div>' +
                '<div class="channel-page-title">频道管理</div>' +
                '<div class="channel-page-subtitle">点击频道进行配置</div>' +
                '</div>' +
                '</div>';
            page.appendChild(header);

            var list = document.createElement('div');
            list.className = 'channel-list';

            channelsData.registered.forEach(function (type) {
                var cfg = (channelsData.config && channelsData.config[type]) || {};
                var meta = getChannelMeta(type);
                var isOn = !!cfg.enabled;

                var item = document.createElement('div');
                item.className = 'channel-item';
                item.dataset.type = type;
                item.innerHTML =
                    '<div class="channel-item-icon ' + meta.iconClass + '">' + escapeHtml(meta.icon) + '</div>' +
                    '<div class="channel-item-info">' +
                    '<div class="channel-item-name">' + escapeHtml(meta.name) + '</div>' +
                    '<div class="channel-item-status ' + (isOn ? 'on' : '') + '">' + (isOn ? '已启用' : '未启用') + '</div>' +
                    '</div>' +
                    '<svg class="channel-item-arrow" width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M5 3l4 4-4 4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';

                item.addEventListener('click', function () {
                    openChannelDrawer(type);
                });
                list.appendChild(item);
            });

            page.appendChild(list);

            var overlay = document.createElement('div');
            overlay.className = 'channel-drawer-overlay';
            overlay.id = 'channel-drawer-overlay';
            overlay.addEventListener('click', closeChannelDrawer);

            var drawer = document.createElement('div');
            drawer.className = 'channel-drawer';
            drawer.id = 'channel-drawer';

            page.appendChild(overlay);
            page.appendChild(drawer);
            channelView.appendChild(page);
        }

        function openChannelDrawer(type) {
            openDrawerType = type;
            var cfg = (channelsData.config && channelsData.config[type]) || {};
            var meta = getChannelMeta(type);
            var isOn = !!cfg.enabled;

            document.querySelectorAll('.channel-item').forEach(function (el) {
                el.classList.toggle('active', el.dataset.type === type);
            });

            var drawer = document.getElementById('channel-drawer');
            var fieldsHtml = '';
            if (type === 'telegram') {
                fieldsHtml =
                    '<div class="channel-drawer-field">' +
                    '<label class="channel-drawer-field-label">Bot Token</label>' +
                    '<input class="channel-drawer-input" id="ch-token-' + type + '" type="password" value="' + escapeHtml(cfg.token || '') + '" placeholder="从 @BotFather 获取的 Token" spellcheck="false">' +
                    '</div>';
            } else if (type === 'weixin') {
                fieldsHtml =
                    '<div class="channel-drawer-field">' +
                    '<label class="channel-drawer-field-label">Bot Token <span style="font-weight:400;color:var(--text-dim)">(首次启用后扫码自动填入)</span></label>' +
                    '<input class="channel-drawer-input" id="ch-token-' + type + '" type="password" value="' + escapeHtml(cfg.token || '') + '" placeholder="扫码后自动填入" spellcheck="false">' +
                    '</div>' +
                    '<div class="channel-drawer-field">' +
                    '<label class="channel-drawer-field-label">Account ID</label>' +
                    '<input class="channel-drawer-input" id="ch-account-' + type + '" value="' + escapeHtml(cfg.accountId || '') + '" placeholder="扫码后自动填入" spellcheck="false">' +
                    '</div>';
            } else {
                fieldsHtml =
                    '<div class="channel-drawer-field">' +
                    '<label class="channel-drawer-field-label">App ID</label>' +
                    '<input class="channel-drawer-input" id="ch-appid-' + type + '" value="' + escapeHtml(cfg.appId || '') + '" placeholder="输入 App ID" spellcheck="false">' +
                    '</div>' +
                    '<div class="channel-drawer-field">' +
                    '<label class="channel-drawer-field-label">App Secret</label>' +
                    '<input class="channel-drawer-input" id="ch-secret-' + type + '" type="password" value="' + escapeHtml(cfg.appSecret || '') + '" placeholder="输入 App Secret" spellcheck="false">' +
                    '</div>';
            }
            fieldsHtml +=
                '<div class="channel-drawer-field">' +
                '<label class="channel-drawer-field-label">Owner Chat ID <span style="font-weight:400;color:var(--text-dim)">(私聊机器人后自动填入)</span></label>' +
                '<input class="channel-drawer-input" id="ch-owner-' + type + '" value="' + escapeHtml(cfg.ownerChatId || '') + '" placeholder="私聊机器人一次即可自动记录" spellcheck="false">' +
                '</div>';

            drawer.innerHTML =
                '<div class="channel-drawer-header">' +
                '<div class="channel-drawer-icon ' + meta.iconClass + '">' + escapeHtml(meta.icon) + '</div>' +
                '<span class="channel-drawer-title">' + escapeHtml(meta.name) + '</span>' +
                '<button class="channel-drawer-close" id="drawer-close-btn">' +
                '<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M3.5 3.5l7 7M10.5 3.5l-7 7" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>' +
                '</button>' +
                '</div>' +
                '<div class="channel-drawer-body">' +
                '<div class="channel-drawer-row">' +
                '<span class="channel-drawer-row-label">启用频道</span>' +
                '<button class="channel-toggle ' + (isOn ? 'on' : '') + '" id="ch-toggle-' + type + '"></button>' +
                '</div>' +
                '<div class="channel-drawer-fields">' + fieldsHtml + '</div>' +
                '</div>' +
                '<div class="channel-drawer-footer">' +
                '<button class="channel-drawer-save" id="ch-save-' + type + '">保存</button>' +
                '<span class="channel-save-ok" id="save-ok-' + type + '">' +
                '<svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2 6.5l2.5 2.5L10 3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
                '已保存' +
                '</span>' +
                '</div>';

            document.getElementById('drawer-close-btn').addEventListener('click', closeChannelDrawer);
            document.getElementById('ch-toggle-' + type).addEventListener('click', function () {
                this.classList.toggle('on');
                if (type === 'weixin' && this.classList.contains('on')) {
                    var tokenInput = document.getElementById('ch-token-' + type);
                    var accountInput = document.getElementById('ch-account-' + type);
                    var hasToken = tokenInput && tokenInput.value.trim();
                    var hasAccount = accountInput && accountInput.value.trim();
                    if (!hasToken || !hasAccount) {
                        openWeixinLoginModal({
                            state: 'pending',
                            message: '正在生成微信登录二维码…'
                        });
                        startWeixinLoginPolling(true);
                        saveChannel(type);
                    }
                }
            });
            document.getElementById('ch-save-' + type).addEventListener('click', function () {
                saveChannel(type);
            });

            requestAnimationFrame(function () {
                document.getElementById('channel-drawer-overlay').classList.add('open');
                drawer.classList.add('open');
            });
        }

        function closeChannelDrawer() {
            var drawer = document.getElementById('channel-drawer');
            var overlay = document.getElementById('channel-drawer-overlay');
            if (drawer) drawer.classList.remove('open');
            if (overlay) overlay.classList.remove('open');
            document.querySelectorAll('.channel-item').forEach(function (el) {
                el.classList.remove('active');
            });
            openDrawerType = null;
        }

        async function saveChannel(type) {
            var toggle = document.getElementById('ch-toggle-' + type);
            var saveBtn = document.getElementById('ch-save-' + type);

            var payload = { enabled: toggle.classList.contains('on') };

            if (type === 'telegram') {
                var tokenInput = document.getElementById('ch-token-' + type);
                payload.token = tokenInput.value.trim();
            } else if (type === 'weixin') {
                var wxTokenInput = document.getElementById('ch-token-' + type);
                var accountInput = document.getElementById('ch-account-' + type);
                var currentWeixinCfg = (channelsData && channelsData.config && channelsData.config.weixin) || {};
                payload.token = wxTokenInput.value.trim();
                payload.accountId = accountInput.value.trim();
                payload.baseUrl = currentWeixinCfg.baseUrl || 'https://ilinkai.weixin.qq.com';
                payload.botAgent = currentWeixinCfg.botAgent || 'AnyBot/0.1.0';
                payload.botType = currentWeixinCfg.botType || '3';
            } else {
                var appIdInput = document.getElementById('ch-appid-' + type);
                var appSecretInput = document.getElementById('ch-secret-' + type);
                payload.appId = appIdInput.value.trim();
                payload.appSecret = appSecretInput.value.trim();
            }
            var ownerInput = document.getElementById('ch-owner-' + type);
            if (ownerInput) {
                payload.ownerChatId = ownerInput.value.trim();
            }

            saveBtn.disabled = true;
            saveBtn.textContent = '保存中…';

            try {
                var res = await fetch('/api/channels/' + type, {
                    method: 'PUT',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify(payload),
                });

                if (!res.ok) {
                    var err = await res.json().catch(function () {
                        return {};
                    });
                    showError(err.error || '保存失败');
                    return;
                }

                var updatedConfig = await res.json();
                if (channelsData) {
                    channelsData.config = updatedConfig;
                }

                var okEl = document.getElementById('save-ok-' + type);
                okEl.classList.add('show');
                setTimeout(function () {
                    okEl.classList.remove('show');
                }, 2000);

                var statusEl = document.querySelector('.channel-item[data-type="' + type + '"] .channel-item-status');
                if (statusEl) {
                    var nowOn = toggle.classList.contains('on');
                    statusEl.textContent = nowOn ? '已启用' : '未启用';
                    statusEl.className = 'channel-item-status' + (nowOn ? ' on' : '');
                }

            } catch (e) {
                showError('保存频道配置失败');
            } finally {
                saveBtn.disabled = false;
                saveBtn.textContent = '保存';
            }
        }

        function isWeixinBound() {
            var cfg = (channelsData && channelsData.config && channelsData.config.weixin) || {};
            return !!(cfg.token && cfg.accountId);
        }

        function syncWeixinDrawerFields() {
            var cfg = (channelsData && channelsData.config && channelsData.config.weixin) || {};
            var tokenInput = document.getElementById('ch-token-weixin');
            var accountInput = document.getElementById('ch-account-weixin');
            var ownerInput = document.getElementById('ch-owner-weixin');
            var toggle = document.getElementById('ch-toggle-weixin');

            if (tokenInput) tokenInput.value = cfg.token || '';
            if (accountInput) accountInput.value = cfg.accountId || '';
            if (ownerInput) ownerInput.value = cfg.ownerChatId || '';
            if (toggle) toggle.classList.toggle('on', !!cfg.enabled);

            var statusEl = document.querySelector('.channel-item[data-type="weixin"] .channel-item-status');
            if (statusEl) {
                statusEl.textContent = cfg.enabled ? '已启用' : '未启用';
                statusEl.className = 'channel-item-status' + (cfg.enabled ? ' on' : '');
            }
        }

        function openWeixinLoginModal(status) {
            var existing = document.getElementById('weixin-login-overlay');
            if (existing) {
                updateWeixinLoginModal(status || {});
                return;
            }

            var overlay = document.createElement('div');
            overlay.className = 'weixin-login-overlay open';
            overlay.id = 'weixin-login-overlay';
            overlay.innerHTML =
                '<div class="weixin-login-modal">' +
                '<button class="weixin-login-close" id="weixin-login-close" aria-label="关闭">' +
                '<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M3.5 3.5l7 7M10.5 3.5l-7 7" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>' +
                '</button>' +
                '<div class="weixin-login-icon">微</div>' +
                '<div class="weixin-login-title">微信扫码绑定</div>' +
                '<div class="weixin-login-subtitle" id="weixin-login-message">正在生成微信登录二维码…</div>' +
                '<div class="weixin-login-qr-frame">' +
                '<img class="weixin-login-qr" id="weixin-login-qr" alt="微信登录二维码">' +
                '<div class="weixin-login-placeholder" id="weixin-login-placeholder">等待二维码</div>' +
                '</div>' +
                '<a class="weixin-login-link" id="weixin-login-link" href="#" target="_blank" rel="noreferrer">打开二维码链接</a>' +
                '</div>';
            document.body.appendChild(overlay);
            document.getElementById('weixin-login-close').addEventListener('click', closeWeixinLoginModal);
            overlay.addEventListener('click', function (e) {
                if (e.target === overlay) closeWeixinLoginModal();
            });
            updateWeixinLoginModal(status || {});
        }

        function closeWeixinLoginModal() {
            if (weixinLoginPollTimer) {
                clearInterval(weixinLoginPollTimer);
                weixinLoginPollTimer = null;
            }
            var overlay = document.getElementById('weixin-login-overlay');
            if (!overlay) return;
            overlay.classList.remove('open');
            setTimeout(function () { overlay.remove(); }, 180);
        }

        function updateWeixinLoginModal(status) {
            var overlay = document.getElementById('weixin-login-overlay');
            if (!overlay) return;
            var messageEl = document.getElementById('weixin-login-message');
            var imgEl = document.getElementById('weixin-login-qr');
            var placeholderEl = document.getElementById('weixin-login-placeholder');
            var linkEl = document.getElementById('weixin-login-link');
            var message = status.message || '正在生成微信登录二维码…';
            if (status.state === 'confirmed') message = '微信绑定成功';
            if (status.state === 'failed') message = status.message || '微信绑定失败';
            messageEl.textContent = message;

            if (status.qrcodeDataUrl) {
                imgEl.src = status.qrcodeDataUrl;
                imgEl.style.display = 'block';
                placeholderEl.style.display = 'none';
            } else {
                imgEl.style.display = 'none';
                placeholderEl.style.display = 'flex';
            }

            if (status.qrcodeUrl) {
                linkEl.href = status.qrcodeUrl;
                linkEl.style.display = 'inline-flex';
            } else {
                linkEl.style.display = 'none';
            }
        }

        function startWeixinLoginPolling(showModal) {
            if (weixinLoginPollTimer) clearInterval(weixinLoginPollTimer);
            pollWeixinLoginStatus(showModal);
            weixinLoginPollTimer = setInterval(function () {
                pollWeixinLoginStatus(showModal);
            }, 1500);
        }

        async function pollWeixinLoginStatus(showModal) {
            try {
                await fetchChannels();
                if (isWeixinBound()) {
                    syncWeixinDrawerFields();
                    closeWeixinLoginModal();
                    return;
                }

                var res = await fetch('/api/channels/weixin/login-status');
                if (!res.ok) return;
                var status = await res.json();
                var shouldShow = showModal || ['pending', 'scanned', 'waiting_code'].indexOf(status.state) >= 0;
                if (!shouldShow || status.state === 'idle') return;
                openWeixinLoginModal(status);
                if (status.state === 'confirmed') {
                    if (weixinLoginPollTimer) {
                        clearInterval(weixinLoginPollTimer);
                        weixinLoginPollTimer = null;
                    }
                    await fetchChannels();
                    syncWeixinDrawerFields();
                    closeWeixinLoginModal();
                }
                if (status.state === 'failed' && weixinLoginPollTimer) {
                    clearInterval(weixinLoginPollTimer);
                    weixinLoginPollTimer = null;
                }
            } catch (e) {
                console.error('Failed to fetch weixin login status:', e);
            }
        }

        async function fetchSkills() {
            try {
                var res = await fetch('/api/skills');
                skillsData = await res.json();
            } catch (e) {
                console.error('Failed to fetch skills:', e);
                skillsData = { skills: [], sources: [] };
            }
        }

        var skillsSearchTerm = '';

        function renderSkillsView() {
            skillsView.innerHTML = '';
            if (!skillsData) return;

            var page = document.createElement('div');
            page.className = 'skills-page';

            var header = document.createElement('div');
            header.className = 'skills-header';
            header.innerHTML =
                '<div class="skills-header-top">' +
                '<div class="skills-header-icon">' +
                '<svg width="22" height="22" viewBox="0 0 14 14" fill="none"><path d="M7 1L8.5 4.5L12.5 5L9.75 7.5L10.5 11.5L7 9.5L3.5 11.5L4.25 7.5L1.5 5L5.5 4.5L7 1Z" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
                '</div>' +
                '<div>' +
                '<div class="skills-header-title">技能管理</div>' +
                '<div class="skills-header-count">' + skillsData.skills.length + ' 个技能可用</div>' +
                '</div>' +
                '</div>';
            page.appendChild(header);

            var toolbar = document.createElement('div');
            toolbar.className = 'skills-toolbar';

            var searchInput = document.createElement('input');
            searchInput.className = 'skills-search';
            searchInput.type = 'text';
            searchInput.placeholder = '搜索技能名称、描述或路径…';
            searchInput.value = skillsSearchTerm;
            searchInput.id = 'skills-search-input';
            searchInput.addEventListener('input', function () {
                skillsSearchTerm = this.value;
                renderSkillsList();
            });

            var refreshBtn = document.createElement('button');
            refreshBtn.className = 'skills-toolbar-btn';
            refreshBtn.title = '刷新';
            refreshBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M1.5 7a5.5 5.5 0 0 1 9.35-3.95M12.5 7a5.5 5.5 0 0 1-9.35 3.95" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/><path d="M10.5 1v2.5H13M3.5 13v-2.5H1" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
            refreshBtn.addEventListener('click', function () {
                fetchSkills().then(function () {
                    renderSkillsView();
                    showSaveStatus('技能列表已刷新');
                });
            });

            var openFolderBtn = document.createElement('button');
            openFolderBtn.className = 'skills-toolbar-btn';
            openFolderBtn.title = '打开文件夹';
            openFolderBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M1.5 3.5v7a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1v-5a1 1 0 0 0-1-1H7L5.5 3.5H2.5a1 1 0 0 0-1 1z" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round"/></svg>';
            openFolderBtn.addEventListener('click', function () {
                fetch('/api/skills/open-folder', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({}),
                });
            });

            toolbar.appendChild(searchInput);
            toolbar.appendChild(refreshBtn);
            toolbar.appendChild(openFolderBtn);
            page.appendChild(toolbar);

            var listContainer = document.createElement('div');
            listContainer.className = 'skills-list';
            listContainer.id = 'skills-list-container';
            page.appendChild(listContainer);

            var footer = document.createElement('div');
            footer.className = 'skills-footer';
            footer.innerHTML =
                '<div class="skills-save-status" id="skills-save-status">' +
                '<svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2 6.5l2.5 2.5L10 3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
                '所有更改已保存' +
                '</div>' +
                '<div class="skills-footer-actions">' +
                '<button class="skills-footer-btn" id="skills-close-btn">关闭</button>' +
                '</div>';
            page.appendChild(footer);

            skillsView.appendChild(page);

            document.getElementById('skills-close-btn').addEventListener('click', function () {
                showChatView();
            });

            renderSkillsList();
        }

        function renderSkillsList() {
            var container = document.getElementById('skills-list-container');
            if (!container || !skillsData) return;
            container.innerHTML = '';

            var term = skillsSearchTerm.toLowerCase().trim();
            var filtered = skillsData.skills;
            if (term) {
                filtered = filtered.filter(function (s) {
                    return s.name.toLowerCase().indexOf(term) !== -1 ||
                        s.description.toLowerCase().indexOf(term) !== -1 ||
                        s.fullPath.toLowerCase().indexOf(term) !== -1;
                });
            }

            if (filtered.length === 0) {
                container.innerHTML =
                    '<div class="skills-empty">' +
                    '<div class="skills-empty-icon">' +
                    '<svg width="20" height="20" viewBox="0 0 14 14" fill="none"><circle cx="6" cy="6" r="4.5" stroke="currentColor" stroke-width="1.2"/><path d="M9.5 9.5L12.5 12.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>' +
                    '</div>' +
                    '<div class="skills-empty-text">' + (term ? '没有找到匹配的技能' : '暂无可用技能') + '</div>' +
                    '</div>';
                return;
            }

            var grouped = {};
            filtered.forEach(function (s) {
                if (!grouped[s.source]) grouped[s.source] = [];
                grouped[s.source].push(s);
            });

            Object.keys(grouped).forEach(function (source) {
                var items = grouped[source];
                var group = document.createElement('div');
                group.className = 'skills-group';

                var label = document.createElement('div');
                label.className = 'skills-group-label';
                label.innerHTML = escapeHtml(source) + ' <span class="skills-group-badge">' + items.length + '</span>';
                group.appendChild(label);

                items.forEach(function (skill) {
                    group.appendChild(createSkillCard(skill));
                });

                container.appendChild(group);
            });
        }

        function createSkillCard(skill) {
            var card = document.createElement('div');
            card.className = 'skill-card';
            card.dataset.skillId = skill.id;

            var top = document.createElement('div');
            top.className = 'skill-card-top';

            var info = document.createElement('div');
            info.className = 'skill-card-info';
            info.innerHTML =
                '<div class="skill-card-name">' + escapeHtml(skill.name) + '</div>' +
                '<div class="skill-card-desc">' + escapeHtml(skill.description || '暂无描述') + '</div>';

            var actions = document.createElement('div');
            actions.className = 'skill-card-actions';

            var toggle = document.createElement('button');
            toggle.className = 'skill-toggle' + (skill.enabled ? ' on' : '');
            toggle.title = skill.enabled ? '点击禁用' : '点击启用';
            toggle.addEventListener('click', function () {
                var newState = !toggle.classList.contains('on');
                toggle.classList.toggle('on');
                toggle.title = newState ? '点击禁用' : '点击启用';
                skill.enabled = newState;
                fetch('/api/skills/' + encodeURIComponent(skill.id) + '/toggle', {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ enabled: newState }),
                }).then(function (res) {
                    if (!res.ok) throw new Error('toggle failed');
                    showSaveStatus(newState ? '已启用: ' + skill.name : '已禁用: ' + skill.name);
                }).catch(function () {
                    toggle.classList.toggle('on', !newState);
                    toggle.title = !newState ? '点击禁用' : '点击启用';
                    skill.enabled = !newState;
                    showError('切换技能状态失败');
                });
            });

            var openBtn = document.createElement('button');
            openBtn.className = 'skill-open-btn';
            openBtn.title = '打开文件夹';
            openBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M1 3v6.5a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V5a1 1 0 0 0-1-1H6L4.5 3H2a1 1 0 0 0-1 1z" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"/></svg>';
            openBtn.addEventListener('click', function () {
                fetch('/api/skills/open-folder', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ path: skill.fullPath }),
                });
            });

            var delBtn = document.createElement('button');
            delBtn.className = 'skill-delete-btn';
            delBtn.title = '删除技能';
            delBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2 3h8M4.5 3V2a.5.5 0 0 1 .5-.5h2a.5.5 0 0 1 .5.5v1M3 3v7a1 1 0 0 0 1 1h4a1 1 0 0 0 1-1V3" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"/></svg>';
            delBtn.addEventListener('click', function () {
                if (!confirm('确定要删除技能 "' + skill.name + '" 吗？此操作不可撤销。')) return;
                fetch('/api/skills/' + encodeURIComponent(skill.id), {
                    method: 'DELETE',
                }).then(function (res) {
                    if (res.ok) {
                        card.style.transition = 'opacity 0.2s, transform 0.2s';
                        card.style.opacity = '0';
                        card.style.transform = 'translateX(10px)';
                        setTimeout(function () {
                            card.remove();
                            skillsData.skills = skillsData.skills.filter(function (s) { return s.id !== skill.id; });
                            var countEl = document.querySelector('.skills-header-count');
                            if (countEl) countEl.textContent = skillsData.skills.length + ' 个技能可用';
                            showSaveStatus('已删除: ' + skill.name);
                        }, 200);
                    } else {
                        showError('删除技能失败');
                    }
                }).catch(function () {
                    showError('删除技能失败');
                });
            });

            actions.appendChild(toggle);
            actions.appendChild(openBtn);
            actions.appendChild(delBtn);
            top.appendChild(info);
            top.appendChild(actions);
            card.appendChild(top);

            var expand = document.createElement('div');
            expand.className = 'skill-card-expand';

            var expandBtn = document.createElement('button');
            expandBtn.className = 'skill-expand-btn';
            expandBtn.innerHTML = '查看详情 <svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M2 3.5l3 3 3-3" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

            var detail = document.createElement('div');
            detail.className = 'skill-detail';
            detail.innerHTML =
                '<div class="skill-detail-path">📁 ' + escapeHtml(skill.fullPath) + '</div>' +
                '<div class="skill-detail-content">' + escapeHtml(skill.content) + '</div>';

            expandBtn.addEventListener('click', function () {
                var isOpen = detail.classList.contains('show');
                detail.classList.toggle('show');
                expandBtn.classList.toggle('open');
                expandBtn.innerHTML = (isOpen ? '查看详情' : '收起详情') +
                    ' <svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M2 3.5l3 3 3-3" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
            });

            expand.appendChild(expandBtn);
            expand.appendChild(detail);
            card.appendChild(expand);

            return card;
        }

        function showSaveStatus(msg) {
            var el = document.getElementById('skills-save-status');
            if (!el) return;
            el.innerHTML =
                '<svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2 6.5l2.5 2.5L10 3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg> ' +
                escapeHtml(msg);
            el.style.opacity = '1';
            clearTimeout(el._timer);
            el._timer = setTimeout(function () {
                el.innerHTML =
                    '<svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2 6.5l2.5 2.5L10 3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg> 所有更改已保存';
            }, 3000);
        }

        document.addEventListener('keydown', function (e) {
            if (e.key === 'Escape' && openDrawerType) {
                closeChannelDrawer();
                return;
            }
            if (currentView !== 'skills') return;
            if (e.key === '/' || (e.metaKey && e.key === 'f') || (e.ctrlKey && e.key === 'f')) {
                var searchEl = document.getElementById('skills-search-input');
                if (searchEl && document.activeElement !== searchEl) {
                    e.preventDefault();
                    searchEl.focus();
                }
            }
        });

        async function init() {
            updateProjectsCollapsedState();
            updateHistoryCollapsedState();
            await Promise.all([fetchProjects(), fetchSessions(), fetchModelConfig(), fetchProviders(), fetchSandboxConfig(), fetchAppSettings(), fetchProxyConfig()]);
            if (sessions.length > 0) {
                await loadSession(sessions[0].id);
            } else {
                await createNewChat();
            }
            startSidebarAutoRefresh();
            inputEl.focus();
        }

        init();
    })();
