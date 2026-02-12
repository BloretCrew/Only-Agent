import * as vscode from 'vscode';
import * as path from 'path';

export function activate(context: vscode.ExtensionContext) {
    const provider = new ManualAIChatViewProvider(context.extensionUri);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider('Only-Agent.chatView', provider),
        vscode.commands.registerCommand('only-agent.clearHistory', () => provider.clearChat())
    );
}

interface AgentAction {
    id: string;
    type: 'MODIFY' | 'CREATE' | 'DELETE' | 'SHELL' | 'FETCH';
    path?: string;
    content?: string;
    before?: string;
    command?: string;
    url?: string;
}

interface ChatMessage {
    role: 'user' | 'ai' | 'system' | 'error' | 'action';
    text: string;
    action?: AgentAction;
}

class ManualAIChatViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'Only-Agent.chatView';
    private _view?: vscode.WebviewView;
    private _pendingActions: AgentAction[] = [];
    private _chatHistory: ChatMessage[] = [];

    constructor(private readonly _extensionUri: vscode.Uri) { 
        this._chatHistory.push({ 
            role: 'system', 
            text: '欢迎使用 Manual AI Agent。<br>1. 输入需求并点击 "Copy Prompt"。<br>2. 粘贴 AI 回复并点击 "Apply Changes"。' 
        });
    }

    public resolveWebviewView(webviewView: vscode.WebviewView) {
        this._view = webviewView;
        webviewView.webview.options = { enableScripts: true, localResourceRoots: [this._extensionUri] };
        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

        webviewView.webview.onDidReceiveMessage(async (data) => {
            switch (data.type) {
                case 'copyPrompt': 
                    await this.handleCopyPrompt(data.inputValue, data.options); 
                    break;
                case 'applyChange': 
                    await this.parseAndConfirmActions(data.inputValue); 
                    break;
                case 'approveAction': 
                    await this.executeAction(data.actionId); 
                    break;
                case 'approveAll': 
                    await this.handleApproveAll(); 
                    break;
                case 'ready':
                    this.restoreHistory();
                    break;
            }
        });
    }

    public clearChat() {
        this._chatHistory = [];
        this._pendingActions = [];
        this._view?.webview.postMessage({ type: 'clearChat' });
        this._chatHistory.push({ role: 'system', text: '🗑️ 历史记录已清空。' });
        this.restoreHistory();
    }

    private restoreHistory() {
        if (this._view) {
            this._view.webview.postMessage({ type: 'restoreHistory', history: this._chatHistory });
            if (this._pendingActions.length > 0) {
                this._view.webview.postMessage({ type: 'toggleApproveAll', show: true });
            }
        }
    }

    private addToHistory(message: ChatMessage) {
        this._chatHistory.push(message);
        this._view?.webview.postMessage({ type: 'addMessage', message });
    }

    private async handleApproveAll() {
        const safeActions = this._pendingActions.filter(a => a.type !== 'SHELL');
        const skippedCount = this._pendingActions.length - safeActions.length;
        
        const actionIds = safeActions.map(a => a.id);
        for (const id of actionIds) {
            await this.executeAction(id);
        }
        
        if (skippedCount > 0) {
            this.addToHistory({ role: 'system', text: `⚠️ 已跳过 ${skippedCount} 个终端命令 (Approve All 不包含终端指令)。` });
        }

        const remaining = this._pendingActions.filter(a => !actionIds.includes(a.id));
        if (remaining.length === 0 || remaining.every(a => a.type === 'SHELL')) {
            this._view?.webview.postMessage({ type: 'toggleApproveAll', show: false });
        }
    }

    private async getProjectStructure(): Promise<string> {
        const folders = vscode.workspace.workspaceFolders;
        if (!folders) return "No workspace opened.";
        let structure = "";
        for (const folder of folders) {
            structure += `Project: ${folder.name}\n`;
            const files = await vscode.workspace.findFiles(new vscode.RelativePattern(folder, '**/*'), '**/node_modules/**', 100);
            files.forEach(f => structure += `- ${path.relative(folder.uri.fsPath, f.fsPath)}\n`);
        }
        return structure;
    }

    private async handleCopyPrompt(userInstruction: string, options: { includeStructure: boolean, includeOpenFiles: boolean }) {
        let contextText = "";
        let logMsg = "✅ 已复制 Prompt";

        if (options.includeStructure) {
            const structure = await this.getProjectStructure();
            contextText += `项目结构：\n${structure}\n\n`;
            logMsg += " (含项目结构)";
        }

        if (options.includeOpenFiles) {
            let openFilesContext = "";
            for (const doc of vscode.workspace.textDocuments) {
                if (!doc.fileName.includes('node_modules') && doc.uri.scheme === 'file') {
                    openFilesContext += `\nFile: ${doc.fileName}\n\`\`\`\n${doc.getText()}\n\`\`\`\n`;
                }
            }
            if (openFilesContext) {
                contextText += `当前打开的文件内容：\n${openFilesContext}\n\n`;
                logMsg += " (含打开文件)";
            }
        }

        const prompt = `你是一个强大的 AI Agent。请用简体中文回复。
你可以执行以下工具指令，请严格遵守格式：

1. 修改代码:
{{TOOL_CALL:MODIFY}}
FILE: 文件路径
BEFORE:
\`\`\`
原代码块
\`\`\`
AFTER:
\`\`\`
修改后代码块
\`\`\`

2. 创建文件:
{{TOOL_CALL:CREATE}}
FILE: 文件路径
CONTENT:
\`\`\`
文件内容
\`\`\`

3. 删除文件:
{{TOOL_CALL:DELETE}}
FILE: 文件路径

4. 终端指令:
{{TOOL_CALL:SHELL}}
COMMAND: 指令内容

5. 网络请求:
{{TOOL_CALL:FETCH}}
URL: 请求地址

${contextText}User Request: ${userInstruction}`;

        await vscode.env.clipboard.writeText(prompt);
        this.addToHistory({ role: 'system', text: logMsg });
    }

    private async parseAndConfirmActions(aiResponse: string) {
        this.addToHistory({ role: 'ai', text: aiResponse });

        const currentBatch: AgentAction[] = [];
        const actionRegex = /{{\s*TOOL_CALL:\s*(\w+)\s*}}([\s\S]*?)(?={{\s*TOOL_CALL:|$)/g;
        let match;

        while ((match = actionRegex.exec(aiResponse)) !== null) {
            const type = match[1];
            const body = match[2];
            const id = Math.random().toString(36).substring(7);
            const action: AgentAction = { id, type: type as any };

            const getField = (body: string, field: string) => {
                const reg = new RegExp(`(?:\\*\\*)?${field}:(?:\\*\\*)?\\s*(.*)`, 'i');
                return body.match(reg)?.[1]?.trim();
            };
            const getCodeBlock = (body: string, field: string) => {
                const reg = new RegExp(`(?:\\*\\*)?${field}:(?:\\*\\*)?\\s*[\\s\\S]*?\`\`\`[\\w]*\\n?([\\s\\S]*?)\\n?\`\`\``, 'i');
                return body.match(reg)?.[1];
            };

            if (type === 'MODIFY') {
                action.path = getField(body, 'FILE');
                action.before = getCodeBlock(body, 'BEFORE');
                action.content = getCodeBlock(body, 'AFTER');
            } else if (type === 'CREATE') {
                action.path = getField(body, 'FILE');
                action.content = getCodeBlock(body, 'CONTENT');
            } else if (type === 'DELETE') {
                action.path = getField(body, 'FILE');
            } else if (type === 'SHELL') {
                action.command = getField(body, 'COMMAND');
            } else if (type === 'FETCH') {
                action.url = getField(body, 'URL');
            }

            if (action.type) {
                currentBatch.push(action);
                this._pendingActions.push(action);
                this.addToHistory({ role: 'action', text: '', action });
            }
        }

        if (currentBatch.length > 0) {
            this._view?.webview.postMessage({ type: 'toggleApproveAll', show: true });
        } else {
            this.addToHistory({ role: 'error', text: '❌ 未识别到有效的 TOOL_CALL 指令。' });
        }
    }

    private async executeAction(actionId: string) {
        const index = this._pendingActions.findIndex(a => a.id === actionId);
        if (index === -1) return;
        const action = this._pendingActions[index];

        try {
            const workspaceRoot = vscode.workspace.workspaceFolders?.[0].uri.fsPath;
            if (!workspaceRoot) throw new Error("未打开工作区");

            switch (action.type) {
                case 'MODIFY':
                    const doc = await vscode.workspace.openTextDocument(path.resolve(workspaceRoot, action.path!));
                    const editor = await vscode.window.showTextDocument(doc);
                    const fullText = doc.getText();
                    
                    // 1. 尝试精确匹配
                    const offset = fullText.indexOf(action.before!);
                    if (offset !== -1) {
                        await editor.edit(e => e.replace(new vscode.Range(doc.positionAt(offset), doc.positionAt(offset + action.before!.length)), action.content!));
                    } else {
                        // 2. 尝试基于行的模糊匹配 (忽略首尾空行和每行的缩进)
                        const docLines = fullText.split(/\r?\n/);
                        const searchLines = action.before!.split(/\r?\n/);
                        
                        // 移除搜索块首尾的空行
                        let startSearch = 0; 
                        let endSearch = searchLines.length - 1;
                        while (startSearch <= endSearch && searchLines[startSearch].trim() === '') startSearch++;
                        while (endSearch >= startSearch && searchLines[endSearch].trim() === '') endSearch--;
                        
                        const effectiveSearchLines = searchLines.slice(startSearch, endSearch + 1);
                        
                        if (effectiveSearchLines.length === 0) {
                             throw new Error("原文块为空或全是空白，无法匹配。");
                        }

                        let foundLineIndex = -1;
                        for (let i = 0; i <= docLines.length - effectiveSearchLines.length; i++) {
                            let match = true;
                            for (let j = 0; j < effectiveSearchLines.length; j++) {
                                if (docLines[i + j].trim() !== effectiveSearchLines[j].trim()) {
                                    match = false;
                                    break;
                                }
                            }
                            if (match) {
                                foundLineIndex = i;
                                break;
                            }
                        }

                        if (foundLineIndex !== -1) {
                            const startPos = new vscode.Position(foundLineIndex, 0);
                            const lastLineIndex = foundLineIndex + effectiveSearchLines.length - 1;
                            const endPos = doc.lineAt(lastLineIndex).range.end;
                            await editor.edit(e => e.replace(new vscode.Range(startPos, endPos), action.content!));
                        } else {
                            throw new Error("找不到原文块，无法修改。");
                        }
                    }
                    break;
                case 'CREATE':
                    const newUri = vscode.Uri.file(path.resolve(workspaceRoot, action.path!));
                    await vscode.workspace.fs.writeFile(newUri, Buffer.from(action.content || ''));
                    break;
                case 'DELETE':
                    const delUri = vscode.Uri.file(path.resolve(workspaceRoot, action.path!));
                    await vscode.workspace.fs.delete(delUri);
                    break;
                case 'SHELL':
                    const terminal = vscode.window.activeTerminal || vscode.window.createTerminal();
                    terminal.show();
                    terminal.sendText(action.command!);
                    break;
                case 'FETCH':
                    if (action.url) vscode.env.openExternal(vscode.Uri.parse(action.url));
                    break;
            }
            
            this._pendingActions.splice(index, 1);
            this._view?.webview.postMessage({ type: 'actionComplete', actionId });
            
            const remainingNonShell = this._pendingActions.filter(a => a.type !== 'SHELL');
            if (remainingNonShell.length === 0) {
                this._view?.webview.postMessage({ type: 'toggleApproveAll', show: false });
            }

        } catch (e: any) {
            this._view?.webview.postMessage({ type: 'actionError', actionId, error: e.message });
            vscode.window.showErrorMessage(`执行失败: ${e.message}`);
        }
    }

    private _getHtmlForWebview(webview: vscode.Webview) {
        return `<!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline' https://cdn.jsdelivr.net; script-src 'unsafe-inline' https://cdn.jsdelivr.net; img-src https: data:;">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"><\/script>
            <style>
                body {
                    padding: 0;
                    margin: 0;
                    font-family: var(--vscode-font-family);
                    background-color: var(--vscode-editor-background);
                    color: var(--vscode-editor-foreground);
                    display: flex;
                    flex-direction: column;
                    height: 100vh;
                }
                
                #chat-history {
                    flex: 1;
                    overflow-y: auto;
                    padding: 10px;
                    display: flex;
                    flex-direction: column;
                    gap: 10px;
                }

                .message {
                    padding: 8px 12px;
                    border-radius: 6px;
                    max-width: 95%;
                    word-wrap: break-word;
                    font-size: 13px;
                    line-height: 1.5;
                }
                
                .message p { margin: 0 0 8px 0; }
                .message p:last-child { margin: 0; }
                .message pre { background: var(--vscode-textBlockQuote-background); padding: 5px; overflow-x: auto; border-radius: 4px; }
                .message code { font-family: var(--vscode-editor-font-family); font-size: 0.9em; }

                .message.user {
                    align-self: flex-end;
                    background-color: var(--vscode-button-secondaryBackground);
                    color: var(--vscode-button-secondaryForeground);
                }

                .message.ai {
                    align-self: flex-start;
                    background-color: var(--vscode-editor-inactiveSelectionBackground);
                }

                .message.system {
                    align-self: center;
                    font-style: italic;
                    color: var(--vscode-descriptionForeground);
                    font-size: 12px;
                    text-align: center;
                }
                
                .message.error {
                    align-self: flex-start;
                    background-color: var(--vscode-inputValidation-errorBackground);
                    border: 1px solid var(--vscode-inputValidation-errorBorder);
                }
                
                .action-error-text {
                    color: var(--vscode-errorForeground);
                    font-size: 12px;
                    margin-top: 5px;
                    font-weight: bold;
                }

                #input-area {
                    padding: 10px;
                    border-top: 1px solid var(--vscode-panel-border);
                    background-color: var(--vscode-sideBar-background);
                }

                .context-controls {
                    display: flex;
                    gap: 10px;
                    margin-bottom: 5px;
                    font-size: 11px;
                    color: var(--vscode-descriptionForeground);
                }

                .context-controls label {
                    display: flex;
                    align-items: center;
                    cursor: pointer;
                }
                
                .context-controls input {
                    margin-right: 4px;
                }

                textarea {
                    width: 100%;
                    height: 70px;
                    resize: vertical;
                    background-color: var(--vscode-input-background);
                    color: var(--vscode-input-foreground);
                    border: 1px solid var(--vscode-input-border);
                    border-radius: 2px;
                    padding: 5px;
                    font-family: var(--vscode-editor-font-family);
                    outline: none;
                }
                
                textarea:focus {
                    border-color: var(--vscode-focusBorder);
                }

                .button-group {
                    display: flex;
                    gap: 8px;
                    margin-top: 8px;
                }

                button {
                    flex: 1;
                    padding: 6px;
                    border: none;
                    border-radius: 2px;
                    cursor: pointer;
                    font-size: 12px;
                    color: var(--vscode-button-foreground);
                }

                #btn-copy {
                    background-color: var(--vscode-button-secondaryBackground);
                    color: var(--vscode-button-secondaryForeground);
                }
                
                #btn-apply {
                    background-color: var(--vscode-button-background);
                }
                
                #btn-approve-all {
                    background-color: var(--vscode-statusBarItem-warningBackground);
                    color: white;
                }

                button:hover {
                    opacity: 0.9;
                }
            </style>
        </head>
        <body>
            <div id="chat-history"><\/div>
            
            <div id="input-area">
                <div id="global-actions" style="display: none; padding-bottom: 8px;">
                    <button id="btn-approve-all" style="width: 100%;">批准并执行所有非终端指令 (Approve All)<\/button>
                <\/div>
                
                <div class="context-controls">
                    <span>包含上下文:<\/span>
                    <label><input type="checkbox" id="chk-structure" checked> 项目结构<\/label>
                    <label><input type="checkbox" id="chk-files" checked> 打开的文件<\/label>
                <\/div>

                <textarea id="prompt-input" placeholder="输入需求或粘贴 AI 回复..."><\/textarea>
                <div class="button-group">
                    <button id="btn-copy">Copy Prompt<\/button>
                    <button id="btn-apply">Apply Changes<\/button>
                <\/div>
            <\/div>

            <script>
                const vscode = acquireVsCodeApi();
                const chatHistory = document.getElementById('chat-history');
                const promptInput = document.getElementById('prompt-input');
                const globalActions = document.getElementById('global-actions');
                
                vscode.postMessage({ type: 'ready' });

                window.addEventListener('message', event => {
                    const msg = event.data;
                    switch (msg.type) {
                        case 'addMessage':
                            renderMessage(msg.message);
                            break;
                        case 'restoreHistory':
                            chatHistory.innerHTML = '';
                            msg.history.forEach(renderMessage);
                            break;
                        case 'clearChat':
                            chatHistory.innerHTML = '';
                            break;
                        case 'actionComplete':
                            markActionComplete(msg.actionId);
                            break;
                        case 'actionError':
                            showActionError(msg.actionId, msg.error);
                            break;
                        case 'toggleApproveAll':
                            globalActions.style.display = msg.show ? 'block' : 'none';
                            break;
                    }
                });

                document.getElementById('btn-approve-all').onclick = () => {
                    vscode.postMessage({ type: 'approveAll' });
                };

                function renderMessage(message) {
                    if (message.role === 'action') {
                        renderActionCard(message.action);
                        return;
                    }
                    
                    const div = document.createElement('div');
                    div.className = 'message ' + message.role;
                    
                    if (message.role === 'ai' && window.marked) {
                        div.innerHTML = marked.parse(message.text);
                    } else {
                        div.innerHTML = message.text;
                    }
                    
                    chatHistory.appendChild(div);
                    chatHistory.scrollTop = chatHistory.scrollHeight;
                }

                function renderActionCard(action) {
                    const card = document.createElement('div');
                    card.id = 'card-' + action.id;
                    card.className = 'message ai';
                    card.style.borderLeft = '4px solid var(--vscode-button-background)';
                    card.innerHTML = \`
                        <strong>待批准操作: \${action.type}<\/strong><br>
                        <code>\${action.path || action.command || action.url || ''}<\/code><br>
                        <button id="action-\${action.id}" style="margin-top:5px; width:100%">批准并执行<\/button>
                        <div id="error-\${action.id}" class="action-error-text"><\/div>
                    \`;
                    chatHistory.appendChild(card);
                    
                    const btn = document.getElementById('action-' + action.id);
                    btn.onclick = () => {
                        document.getElementById('error-' + action.id).innerText = '';
                        vscode.postMessage({ type: 'approveAction', actionId: action.id });
                    };
                    chatHistory.scrollTop = chatHistory.scrollHeight;
                }

                function markActionComplete(actionId) {
                    const btn = document.getElementById('action-' + actionId);
                    if (btn) {
                        btn.innerText = '✓ 已完成';
                        btn.disabled = true;
                        btn.parentElement.style.opacity = '0.7';
                    }
                }
                
                function showActionError(actionId, errorMsg) {
                    const errDiv = document.getElementById('error-' + actionId);
                    if (errDiv) {
                        errDiv.innerText = '执行错误: ' + errorMsg;
                    }
                }

                document.getElementById('btn-copy').addEventListener('click', () => {
                    vscode.postMessage({
                        type: 'copyPrompt',
                        inputValue: promptInput.value,
                        options: {
                            includeStructure: document.getElementById('chk-structure').checked,
                            includeOpenFiles: document.getElementById('chk-files').checked
                        }
                    });
                });

                document.getElementById('btn-apply').addEventListener('click', () => {
                    const text = promptInput.value;
                    promptInput.value = '';
                    vscode.postMessage({
                        type: 'applyChange',
                        inputValue: text
                    });
                });
            <\/script>
        <\/body>
        <\/html>`;
    }
}