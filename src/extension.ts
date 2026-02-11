import * as vscode from 'vscode';
import * as path from 'path';

export function activate(context: vscode.ExtensionContext) {
    const provider = new ManualAIChatViewProvider(context.extensionUri);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider('Only-Agent.chatView', provider)
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

class ManualAIChatViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'Only-Agent.chatView';
    private _view?: vscode.WebviewView;
    private _pendingActions: AgentAction[] = [];

    constructor(private readonly _extensionUri: vscode.Uri) { }

    public resolveWebviewView(webviewView: vscode.WebviewView) {
        this._view = webviewView;
        webviewView.webview.options = { enableScripts: true, localResourceRoots: [this._extensionUri] };
        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

        webviewView.webview.onDidReceiveMessage(async (data) => {
            switch (data.type) {
                case 'copyPrompt': await this.handleCopyPrompt(data.inputValue); break;
                case 'applyChange': await this.parseAndConfirmActions(data.inputValue); break;
                case 'approveAction': await this.executeAction(data.actionId); break;
            }
        });
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

    private async handleCopyPrompt(userInstruction: string) {
        const structure = await this.getProjectStructure();
        // 获取所有打开的编辑器内容
        let openFilesContext = "";
        for (const doc of vscode.workspace.textDocuments) {
            if (!doc.fileName.includes('node_modules')) {
                openFilesContext += `\nFile: ${doc.fileName}\n\`\`\`\n${doc.getText()}\n\`\`\`\n`;
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

项目结构：
${structure}

当前打开的文件内容：
${openFilesContext}

User Request: ${userInstruction}`;

        await vscode.env.clipboard.writeText(prompt);
        this._view?.webview.postMessage({ type: 'addMessage', role: 'system', text: '✅ 已复制项目结构、打开的文件及 Prompt。' });
    }

    private async parseAndConfirmActions(aiResponse: string) {
        this._pendingActions = [];
        const actionRegex = /{{TOOL_CALL:(\w+)}}([\s\S]*?)(?={{TOOL_CALL:|$)/g;
        let match;

        while ((match = actionRegex.exec(aiResponse)) !== null) {
            const type = match[1];
            const body = match[2];
            const id = Math.random().toString(36).substring(7);

            const action: AgentAction = { id, type: type as any };

            if (type === 'MODIFY') {
                action.path = body.match(/FILE:\s*(.*)/)?.[1].trim();
                action.before = body.match(/BEFORE:\s*```.*\n([\s\S]*?)\n```/)?.[1];
                action.content = body.match(/AFTER:\s*```.*\n([\s\S]*?)\n```/)?.[1];
            } else if (type === 'CREATE') {
                action.path = body.match(/FILE:\s*(.*)/)?.[1].trim();
                action.content = body.match(/CONTENT:\s*```.*\n([\s\S]*?)\n```/)?.[1];
            } else if (type === 'DELETE') {
                action.path = body.match(/FILE:\s*(.*)/)?.[1].trim();
            } else if (type === 'SHELL') {
                action.command = body.match(/COMMAND:\s*(.*)/)?.[1].trim();
            } else if (type === 'FETCH') {
                action.url = body.match(/URL:\s*(.*)/)?.[1].trim();
            }

            this._pendingActions.push(action);
            this._view?.webview.postMessage({ type: 'renderAction', action });
        }
    }

    private async executeAction(actionId: string) {
        const action = this._pendingActions.find(a => a.id === actionId);
        if (!action) return;

        try {
            switch (action.type) {
                case 'MODIFY':
                    const doc = await vscode.workspace.openTextDocument(path.resolve(vscode.workspace.workspaceFolders![0].uri.fsPath, action.path!));
                    const editor = await vscode.window.showTextDocument(doc);
                    const fullText = doc.getText();
                    const offset = fullText.indexOf(action.before!);
                    if (offset !== -1) {
                        await editor.edit(e => e.replace(new vscode.Range(doc.positionAt(offset), doc.positionAt(offset + action.before!.length)), action.content!));
                    }
                    break;
                case 'CREATE':
                    const newUri = vscode.Uri.file(path.resolve(vscode.workspace.workspaceFolders![0].uri.fsPath, action.path!));
                    await vscode.workspace.fs.writeFile(newUri, Buffer.from(action.content || ''));
                    break;
                case 'DELETE':
                    const delUri = vscode.Uri.file(path.resolve(vscode.workspace.workspaceFolders![0].uri.fsPath, action.path!));
                    await vscode.workspace.fs.delete(delUri);
                    break;
                case 'SHELL':
                    const terminal = vscode.window.activeTerminal || vscode.window.createTerminal();
                    terminal.show();
                    terminal.sendText(action.command!);
                    break;
                case 'FETCH':
                    vscode.env.openExternal(vscode.Uri.parse(action.url!));
                    break;
            }
            this._view?.webview.postMessage({ type: 'actionComplete', actionId });
        } catch (e: any) {
            vscode.window.showErrorMessage(`执行失败: ${e.message}`);
        }
    }

    // --- HTML/CSS/JS 构建 ---
    private _getHtmlForWebview(webview: vscode.Webview) {
        return `<!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
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
                
                /* 聊天记录区域 */
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
                    max-width: 90%;
                    word-wrap: break-word;
                    font-size: 13px;
                    line-height: 1.4;
                }

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
                }
                
                .message.error {
                    align-self: flex-start;
                    background-color: var(--vscode-inputValidation-errorBackground);
                    border: 1px solid var(--vscode-inputValidation-errorBorder);
                }

                /* 底部输入区域 */
                #input-area {
                    padding: 10px;
                    border-top: 1px solid var(--vscode-panel-border);
                    background-color: var(--vscode-sideBar-background);
                }

                textarea {
                    width: 100%;
                    height: 80px;
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

                button:hover {
                    opacity: 0.9;
                }
            </style>
        </head>
        <body>
            <div id="chat-history">
                <div class="message system">欢迎使用 Manual AI Agent。<br>1. 输入需求并点击 "Copy Prompt"。<br>2. 粘贴 AI 回复并点击 "Apply Changes"。</div>
            </div>
            
            <div id="input-area">
                <textarea id="prompt-input" placeholder="在此输入你的需求，或者粘贴 AI 的回复..."></textarea>
                <div class="button-group">
                    <button id="btn-copy">Copy Prompt</button>
                    <button id="btn-apply">Apply Changes</button>
                </div>
            </div>

            <script>
                const vscode = acquireVsCodeApi();
                const chatHistory = document.getElementById('chat-history');
                const promptInput = document.getElementById('prompt-input');

                window.addEventListener('message', event => {
                    const message = event.data;
                    if (message.type === 'addMessage') {
                        addMessage(message.role, message.text);
                    } else if (message.type === 'renderAction') {
                        renderActionCard(message.action);
                    } else if (message.type === 'actionComplete') {
                        document.getElementById('action-' + message.actionId).innerText = '已执行';
                        document.getElementById('action-' + message.actionId).disabled = true;
                    } else if (message.type === 'clearInput') {
                        promptInput.value = '';
                    }
                });

                function addMessage(role, text) {
                    const div = document.createElement('div');
                    div.className = 'message ' + role;
                    div.innerText = text;
                    chatHistory.appendChild(div);
                    chatHistory.scrollTop = chatHistory.scrollHeight;
                }

                function renderActionCard(action) {
                    const card = document.createElement('div');
                    card.className = 'message ai';
                    card.style.borderLeft = '4px solid var(--vscode-button-background)';
                    card.innerHTML = \`
                        <strong>待批准操作: \${action.type}</strong><br>
                        \${action.path || action.command || action.url || ''}<br>
                        <button id="action-\${action.id}" style="margin-top:5px; width:100%">批准并执行</button>
                    \`;
                    chatHistory.appendChild(card);
                    document.getElementById('action-' + action.id).onclick = () => {
                        vscode.postMessage({ type: 'approveAction', actionId: action.id });
                    };
                    chatHistory.scrollTop = chatHistory.scrollHeight;
                }

                // 按钮 1: 复制 Prompt
                document.getElementById('btn-copy').addEventListener('click', () => {
                    const text = promptInput.value;
                    vscode.postMessage({
                        type: 'copyPrompt',
                        inputValue: text
                    });
                });

                // 按钮 2: 应用更改
                document.getElementById('btn-apply').addEventListener('click', () => {
                    const text = promptInput.value;
                    vscode.postMessage({
                        type: 'applyChange',
                        inputValue: text
                    });
                });
            </script>
        </body>
        </html>`;
    }
}