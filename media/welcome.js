(function () {
    const vscode = acquireVsCodeApi();
    const TAG_COLORS = ['red', 'orange', 'yellow', 'green', 'blue', 'purple'];

    // Handle action button clicks
    document.querySelectorAll('.action-button').forEach(button => {
        button.addEventListener('click', () => {
            const action = button.dataset.action;
            if (action) {
                vscode.postMessage({ command: action });
            }
        });
    });

    // ---- Recent projects (all client-side; the page has no network access) ----
    const section = document.querySelector('.recent-projects[data-max]');
    if (!section) {
        return;
    }

    const grid = section.querySelector('.projects-grid');
    const search = document.getElementById('project-search');
    const sortSelect = document.getElementById('project-sort');
    const noMatches = document.getElementById('no-matches');
    const hint = document.getElementById('list-hint');
    const maxProjects = parseInt(section.dataset.max, 10) || 24;
    const cards = Array.from(grid.querySelectorAll('.project-card'));
    const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });

    const isPinned = card => card.dataset.pinned === 'true';
    const isMissing = card => card.dataset.missing === 'true';
    const visibleCards = () => cards.filter(card => !card.hidden);
    const mainOf = card => card.querySelector('.project-main');

    // ---- Sorting: pinned projects always come first, then the chosen order ----
    const comparators = {
        'recent': (a, b) => Number(a.dataset.recency) - Number(b.dataset.recency),
        'name-asc': (a, b) => collator.compare(a.dataset.name, b.dataset.name),
        'name-desc': (a, b) => collator.compare(b.dataset.name, a.dataset.name),
        'path': (a, b) => collator.compare(a.dataset.path, b.dataset.path)
    };

    function applySort() {
        const compare = comparators[sortSelect.value] || comparators['recent'];
        cards
            .sort((a, b) => (Number(isPinned(b)) - Number(isPinned(a))) || compare(a, b))
            .forEach(card => grid.appendChild(card));
    }

    // ---- Filtering ----
    function applyFilter() {
        const query = search.value.trim().toLowerCase();
        let visible = 0;
        cards.forEach(card => {
            let show;
            if (query) {
                // Searching reaches every recent project, not just the first page.
                show = card.dataset.name.toLowerCase().includes(query) ||
                    card.dataset.path.toLowerCase().includes(query) ||
                    card.dataset.note.toLowerCase().includes(query);
            } else {
                show = isPinned(card) || Number(card.dataset.recency) < maxProjects;
            }
            card.hidden = !show;
            if (show) { visible++; }
        });

        if (cards.length === 0) {
            noMatches.textContent = 'No recent projects found';
            noMatches.hidden = false;
        } else {
            noMatches.textContent = 'No projects match your search';
            noMatches.hidden = visible > 0;
        }

        const notShown = query ? 0 : cards.filter(c => !isPinned(c) && Number(c.dataset.recency) >= maxProjects).length;
        if (notShown > 0) {
            hint.textContent = notShown + ' older project' + (notShown === 1 ? ' is' : 's are') +
                ' not shown. Search to find ' + (notShown === 1 ? 'it' : 'them') + '.';
            hint.hidden = false;
        } else {
            hint.hidden = true;
        }
    }

    // Number badges (1-9) on the first nine visible projects.
    function updateShortcuts() {
        const visible = visibleCards();
        cards.forEach(card => {
            const badge = card.querySelector('.shortcut');
            const index = visible.indexOf(card);
            badge.textContent = index >= 0 && index < 9 ? String(index + 1) : '';
        });
    }

    // Re-sorting moves DOM nodes, which can drop keyboard focus; put it back.
    function refresh() {
        const focused = document.activeElement;
        applySort();
        applyFilter();
        updateShortcuts();
        if (focused && focused !== document.activeElement && grid.contains(focused)) {
            focused.focus();
        }
    }

    // ---- Actions ----
    function openCard(card, newWindow) {
        if (card) {
            vscode.postMessage({ command: 'openProject', id: card.dataset.id, newWindow: newWindow === true });
        }
    }

    function togglePin(card) {
        const pinned = !isPinned(card);
        card.dataset.pinned = String(pinned);
        card.classList.toggle('pinned', pinned);
        const button = card.querySelector('[data-act="pin"]');
        const label = pinned ? 'Unpin project' : 'Pin project to the top';
        button.setAttribute('aria-pressed', String(pinned));
        button.setAttribute('aria-label', label);
        button.title = label + ' (P)';
        vscode.postMessage({ command: 'togglePin', id: card.dataset.id, pinned });
        refresh();
    }

    function editTag(card) {
        vscode.postMessage({ command: 'editTag', id: card.dataset.id });
    }

    function removeCard(card) {
        if (isMissing(card)) {
            vscode.postMessage({ command: 'removeProject', id: card.dataset.id });
        }
    }

    function runAction(action, card) {
        if (action === 'pin') { togglePin(card); }
        else if (action === 'newWindow') { openCard(card, true); }
        else if (action === 'tag') { editTag(card); }
        else if (action === 'remove') { removeCard(card); }
    }

    // ---- Messages from the extension ----
    window.addEventListener('message', event => {
        const message = event.data;
        if (!message || typeof message.id !== 'string') {
            return;
        }
        const card = cards.find(c => c.dataset.id === message.id);
        if (!card) {
            return;
        }

        if (message.command === 'tagUpdated') {
            const note = typeof message.note === 'string' ? message.note : '';
            const color = TAG_COLORS.includes(message.color) ? message.color : '';
            card.dataset.note = note;
            card.dataset.color = color;
            TAG_COLORS.forEach(c => card.classList.remove('tag-' + c));
            if (color) { card.classList.add('tag-' + color); }
            const noteEl = card.querySelector('.project-note');
            noteEl.textContent = note;     // textContent: never parsed as HTML
            noteEl.hidden = !note;
            applyFilter();
        } else if (message.command === 'removed') {
            const visible = visibleCards();
            const next = visible[visible.indexOf(card) + 1] || visible[visible.indexOf(card) - 1];
            const hadFocus = grid.contains(document.activeElement) && card.contains(document.activeElement);
            cards.splice(cards.indexOf(card), 1);
            card.remove();
            refresh();
            if (hadFocus && next && cards.includes(next)) { mainOf(next).focus(); }
        }
    });

    // ---- Keyboard navigation between cards ----
    function moveFocus(card, key) {
        const visible = visibleCards();
        const index = visible.indexOf(card);
        let target;

        if (key === 'ArrowLeft') {
            target = visible[index - 1];
        } else if (key === 'ArrowRight') {
            target = visible[index + 1];
        } else {
            const here = card.getBoundingClientRect();
            const down = key === 'ArrowDown';
            const others = visible.filter(c => {
                const top = c.getBoundingClientRect().top;
                return down ? top > here.top + 4 : top < here.top - 4;
            });
            if (others.length === 0) {
                if (!down) { search.focus(); }
                return;
            }
            // Nearest row first, then the closest column within that row.
            const rowGap = Math.min(...others.map(c => Math.abs(c.getBoundingClientRect().top - here.top)));
            target = others
                .filter(c => Math.abs(c.getBoundingClientRect().top - here.top) - rowGap < 4)
                .sort((a, b) =>
                    Math.abs(a.getBoundingClientRect().left - here.left) -
                    Math.abs(b.getBoundingClientRect().left - here.left))[0];
        }

        if (target) {
            mainOf(target).focus();
        }
    }

    grid.addEventListener('click', event => {
        const button = event.target.closest('[data-act]');
        const card = event.target.closest('.project-card');
        if (!card) { return; }
        if (button) {
            event.stopPropagation();
            runAction(button.dataset.act, card);
        } else if (event.target.closest('.project-main')) {
            openCard(card, event.metaKey || event.ctrlKey);
        }
    });

    // Middle-click opens in a new window.
    grid.addEventListener('auxclick', event => {
        const card = event.target.closest('.project-card');
        if (event.button === 1 && card && event.target.closest('.project-main')) {
            event.preventDefault();
            openCard(card, true);
        }
    });

    grid.addEventListener('keydown', event => {
        // Only react to keys pressed on the card itself, not on its small buttons.
        if (!event.target.classList.contains('project-main')) { return; }
        const card = event.target.closest('.project-card');

        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            openCard(card, event.metaKey || event.ctrlKey || event.shiftKey);
        } else if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
            event.preventDefault();
            moveFocus(card, event.key);
        } else if (!(event.ctrlKey || event.metaKey || event.altKey)) {
            const key = event.key.toLowerCase();
            if (key === 'p') { event.preventDefault(); togglePin(card); }
            else if (key === 't') { event.preventDefault(); editTag(card); }
            else if ((event.key === 'Delete' || event.key === 'Backspace') && isMissing(card)) {
                event.preventDefault();
                removeCard(card);
            }
        }
    });

    document.addEventListener('keydown', event => {
        if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) { return; }
        const target = event.target;
        if (target instanceof HTMLInputElement || target instanceof HTMLSelectElement ||
            target instanceof HTMLTextAreaElement) {
            return;
        }

        if (event.key === '/') {
            event.preventDefault();
            search.focus();
            return;
        }

        const digit = /^(?:Digit|Numpad)([1-9])$/.exec(event.code);
        if (digit) {
            const card = visibleCards()[Number(digit[1]) - 1];
            if (card) {
                event.preventDefault();
                openCard(card, event.shiftKey);
            }
            return;
        }

        // Arrow keys with nothing focused jump to the first project.
        if (target === document.body && event.key.startsWith('Arrow')) {
            const first = visibleCards()[0];
            if (first) {
                event.preventDefault();
                mainOf(first).focus();
            }
        }
    });

    // ---- Search & sort controls ----
    sortSelect.addEventListener('change', () => {
        refresh();
        vscode.postMessage({ command: 'setSort', value: sortSelect.value });
    });

    search.addEventListener('input', () => {
        applyFilter();
        updateShortcuts();
        vscode.setState({ query: search.value });
    });

    search.addEventListener('keydown', event => {
        if (event.key === 'Escape') {
            search.value = '';
            applyFilter();
            updateShortcuts();
            vscode.setState({ query: '' });
        } else if (event.key === 'Enter') {
            openCard(visibleCards()[0], event.metaKey || event.ctrlKey || event.shiftKey);
        } else if (event.key === 'ArrowDown') {
            const first = visibleCards()[0];
            if (first) {
                event.preventDefault();
                mainOf(first).focus();
            }
        }
    });

    // The page is rebuilt whenever the tab is shown again; keep what was typed.
    const saved = vscode.getState();
    if (saved && typeof saved.query === 'string') {
        search.value = saved.query;
    }

    refresh();
})();
