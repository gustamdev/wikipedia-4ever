import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import type { ElectronAPI, Unsubscribe } from "../shared/electron-api";
import { IPC } from "../shared/ipc-channels";

function subscribe<T>(channel: string, cb: (payload: T) => void): Unsubscribe {
  const listener = (_event: IpcRendererEvent, payload: T) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => {
    ipcRenderer.removeListener(channel, listener);
  };
}

const api: ElectronAPI = {
  ping: () => ipcRenderer.invoke(IPC.ping),
  llm: {
    generate: (requestId, input) => ipcRenderer.invoke(IPC.llmGenerate, requestId, input),
    cancel: (requestId) => ipcRenderer.invoke(IPC.llmCancel, requestId),
    onToken: (cb) => subscribe(IPC.llmToken, cb),
    onDone: (cb) => subscribe(IPC.llmDone, cb),
    onError: (cb) => subscribe(IPC.llmError, cb),
  },
  models: {
    list: () => ipcRenderer.invoke(IPC.modelsList),
    install: (id) => ipcRenderer.invoke(IPC.modelsInstall, { id }),
    pause: (id) => ipcRenderer.invoke(IPC.modelsPause, { id }),
    resume: (id) => ipcRenderer.invoke(IPC.modelsResume, { id }),
    cancel: (id) => ipcRenderer.invoke(IPC.modelsCancel, { id }),
    remove: (id) => ipcRenderer.invoke(IPC.modelsRemove, { id }),
    setDefault: (id) => ipcRenderer.invoke(IPC.modelsSetDefault, { id }),
    load: (id) => ipcRenderer.invoke(IPC.modelsLoad, { id }),
    active: () => ipcRenderer.invoke(IPC.modelsActive),
    onActiveChanged: (cb) => subscribe(IPC.modelsActiveChanged, cb),
    onChanged: (cb) => subscribe(IPC.modelsChanged, () => cb()),
    onDownloadProgress: (cb) => subscribe(IPC.downloadProgress, cb),
  },
  system: {
    hardware: () => ipcRenderer.invoke(IPC.systemHardware),
  },
  chat: {
    create: (title) => ipcRenderer.invoke(IPC.chatCreate, title === undefined ? {} : { title }),
    list: () => ipcRenderer.invoke(IPC.chatList),
    messages: (conversationId) => ipcRenderer.invoke(IPC.chatMessages, { conversationId }),
    rename: (conversationId, title) => ipcRenderer.invoke(IPC.chatRename, { conversationId, title }),
    delete: (conversationId) => ipcRenderer.invoke(IPC.chatDelete, { conversationId }),
    clear: (conversationId) => ipcRenderer.invoke(IPC.chatClear, { conversationId }),
    send: (conversationId, requestId, content) => ipcRenderer.invoke(IPC.chatSend, { conversationId, requestId, content }),
    cancel: (requestId) => ipcRenderer.invoke(IPC.chatCancel, { requestId }),
    regenerate: (conversationId, requestId) => ipcRenderer.invoke(IPC.chatRegenerate, { conversationId, requestId }),
    setAgent: (conversationId, agentId) => ipcRenderer.invoke(IPC.chatSetAgent, { conversationId, agentId }),
    onChanged: (cb) => subscribe(IPC.chatChanged, cb),
  },
  embeddings: {
    status: () => ipcRenderer.invoke(IPC.embeddingsStatus),
    install: () => ipcRenderer.invoke(IPC.embeddingsInstall),
    similarity: (a, b) => ipcRenderer.invoke(IPC.embeddingsSimilarity, { a, b }),
    onInstallProgress: (cb) => subscribe(IPC.embeddingsInstallProgress, cb),
  },
  vector: {
    loadTestData: () => ipcRenderer.invoke(IPC.vectorLoadTestData),
    clearTestData: () => ipcRenderer.invoke(IPC.vectorClearTestData),
    search: (query, topK) => ipcRenderer.invoke(IPC.vectorSearch, { query, topK }),
    info: () => ipcRenderer.invoke(IPC.vectorInfo),
  },
  ingestion: {
    languages: () => ipcRenderer.invoke(IPC.ingestionLanguages),
    estimate: (language) => ipcRenderer.invoke(IPC.ingestionEstimate, { language }),
    start: (language, options) => ipcRenderer.invoke(IPC.ingestionStart, { language, deleteRaw: options?.deleteRaw === true }),
    cancel: () => ipcRenderer.invoke(IPC.ingestionCancel),
    resume: () => ipcRenderer.invoke(IPC.ingestionResume),
    status: () => ipcRenderer.invoke(IPC.ingestionStatus),
    knowledgeBases: () => ipcRenderer.invoke(IPC.ingestionKnowledgeBases),
    onProgress: (cb) => subscribe(IPC.ingestionProgress, cb),
    onStatusChanged: (cb) => subscribe(IPC.ingestionStatusChanged, () => cb()),
  },
  agents: {
    list: () => ipcRenderer.invoke(IPC.agentsList),
    lastUsed: () => ipcRenderer.invoke(IPC.agentsLastUsed),
  },
  app: {
    openExternal: (url) => ipcRenderer.invoke(IPC.appOpenExternal, { url }),
    copyText: (text) => ipcRenderer.invoke(IPC.appCopyText, { text }),
  },
};

contextBridge.exposeInMainWorld("electronAPI", api);
