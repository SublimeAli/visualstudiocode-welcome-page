(function () {
    const vscode = acquireVsCodeApi();

    // Handle project card clicks
    document.querySelectorAll('.project-card').forEach(card => {
        card.addEventListener('click', () => {
            const path = card.dataset.path;
            if (path) {
                vscode.postMessage({
                    command: 'openProject',
                    path: path
                });
            }
        });

        // Make cards keyboard accessible
        card.setAttribute('tabindex', '0');
        card.setAttribute('role', 'button');
        card.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                card.click();
            }
        });
    });

    // Handle action button clicks
    document.querySelectorAll('.action-button').forEach(button => {
        button.addEventListener('click', () => {
            const action = button.dataset.action;
            if (action) {
                vscode.postMessage({
                    command: action
                });
            }
        });
    });
})();
