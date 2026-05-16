(function () {
    function escapeHtml(value) {
        return String(value || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
    }

    function signedCount(value, sign) {
        return sign + String(Math.max(0, value || 0));
    }

    function statusText(status) {
        if (status === 'approved') return '已通过';
        if (status === 'reverted') return '已撤销';
        return '待审核';
    }

    function statusLabel(status) {
        if (status === 'added') return '新增';
        if (status === 'deleted') return '删除';
        return '修改';
    }

    function hunkText(line) {
        var match = /^@@\s+-\d+(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/.exec(line);
        return match ? '第 ' + match[1] + ' 行附近' : '变更位置';
    }

    function renderDiffLine(cls, prefix, content) {
        return '' +
            '<span class="line ' + cls + '">' +
            '<span class="gutter">' + escapeHtml(prefix) + '</span>' +
            '<span class="code">' + escapeHtml(content || ' ') + '</span>' +
            '</span>';
    }

    function renderDiff(diff) {
        var lines = String(diff || '').split('\n');
        var rendered = [];

        lines.forEach(function (line) {
            var cls = 'ctx';
            var prefix = '';
            var content = line;

            if (
                line.startsWith('diff --git') ||
                line.startsWith('index ') ||
                line.startsWith('---') ||
                line.startsWith('+++')
            ) {
                return;
            }

            if (line === 'Binary files differ') {
                rendered.push(renderDiffLine('meta', '', '二进制文件有变化'));
                return;
            }

            if (line.startsWith('@@')) {
                rendered.push(renderDiffLine('hunk', '', hunkText(line)));
                return;
            }

            if (line.startsWith('+')) {
                cls = 'add';
                prefix = '+';
                content = line.slice(1);
            } else if (line.startsWith('-')) {
                cls = 'del';
                prefix = '-';
                content = line.slice(1);
            } else if (line.startsWith(' ')) {
                content = line.slice(1);
            }

            rendered.push(renderDiffLine(cls, prefix, content));
        });

        return rendered.join('\n') || renderDiffLine('meta', '', '没有可展示的文本变化');
    }

    function renderFile(file, index) {
        var open = index === 0 ? ' open' : '';
        return '' +
            '<details class="change-review-file"' + open + '>' +
            '<summary>' +
            '<span class="change-review-file-main">' +
            '<span class="change-review-file-path">' + escapeHtml(file.path) + '</span>' +
            '<span class="change-review-file-status">' + statusLabel(file.status) + '</span>' +
            '</span>' +
            '<span class="change-review-file-counts">' +
            '<span class="add">' + signedCount(file.additions, '+') + '</span>' +
            '<span class="del">' + signedCount(file.deletions, '-') + '</span>' +
            '</span>' +
            '<span class="change-review-chevron">›</span>' +
            '</summary>' +
            '<pre class="change-review-diff">' + renderDiff(file.diff) + '</pre>' +
            '</details>';
    }

    function renderInner(review) {
        var disabled = review.status !== 'pending' ? ' disabled' : '';
        var files = Array.isArray(review.files) ? review.files : [];
        return '' +
            '<div class="change-review-header">' +
            '<div>' +
            '<div class="change-review-title">已编辑 ' + (review.fileCount || files.length) + ' 个文件</div>' +
            '<div class="change-review-state">' + statusText(review.status) + '</div>' +
            '</div>' +
            '<div class="change-review-total">' +
            '<span class="add">' + signedCount(review.totalAdditions, '+') + '</span>' +
            '<span class="del">' + signedCount(review.totalDeletions, '-') + '</span>' +
            '</div>' +
            '</div>' +
            '<div class="change-review-files">' + files.map(renderFile).join('') + '</div>' +
            (review.error ? '<div class="change-review-error">' + escapeHtml(review.error) + '</div>' : '') +
            '<div class="change-review-actions">' +
            '<button class="change-review-btn secondary" data-action="revert"' + disabled + '>撤销</button>' +
            '<button class="change-review-btn primary" data-action="approve"' + disabled + '>通过</button>' +
            '</div>';
    }

    async function runAction(reviewId, action) {
        var res = await fetch('/api/change-reviews/' + encodeURIComponent(reviewId) + '/' + action, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
        });
        var data = await res.json().catch(function () { return {}; });
        if (!res.ok && !data.review) {
            throw new Error(data.error || '操作失败');
        }
        return data.review || null;
    }

    function render(opts) {
        var review = opts.review;
        if (!review || !review.id || !Array.isArray(review.files) || review.files.length === 0) return null;

        var container = document.createElement('div');
        container.className = 'change-review-card';
        container.dataset.reviewId = review.id;
        container.innerHTML = renderInner(review);

        function update(nextReview) {
            review = nextReview || review;
            container.innerHTML = renderInner(review);
            bindActions();
            if (opts.scrollBottom) opts.scrollBottom();
        }

        function bindActions() {
            container.querySelectorAll('[data-action]').forEach(function (btn) {
                btn.addEventListener('click', async function () {
                    var action = btn.getAttribute('data-action');
                    if (!action || review.status !== 'pending') return;
                    btn.disabled = true;
                    btn.textContent = action === 'revert' ? '撤销中…' : '通过中…';
                    try {
                        var nextReview = await runAction(review.id, action === 'revert' ? 'revert' : 'approve');
                        update(nextReview);
                    } catch (error) {
                        update(Object.assign({}, review, {
                            error: error.message || '操作失败',
                        }));
                    }
                });
            });
        }

        bindActions();
        return container;
    }

    window.ChangeReview = {
        render: render,
        renderDiff: renderDiff,
    };
})();
