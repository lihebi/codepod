import Y from "yjs";
import WebSocket from "ws";

import { WebsocketProvider } from "@codepod/yjs/src/y-websocket";
import { KernelInfo, spawnRuntime } from "./spawner-native";
import { PodResult, RuntimeInfo } from "./yjs-runtime";

function setKernelWS({ socket, kernelId, ydoc }) {
  const rootMap = ydoc.getMap("rootMap");
  const runtimeMap = rootMap.get("runtimeMap") as Y.Map<RuntimeInfo>;
  socket.onopen = () => {
    console.log("Kernel socket opened");
    runtimeMap.set(kernelId, {
      wsStatus: "connected",
    });
    // request kernel status
    socket.send(
      JSON.stringify({
        type: "requestKernelStatus",
        payload: {
          sessionId: kernelId,
        },
      })
    );
  };
  socket.onclose = () => {
    console.log("Kernel socket closed");
    runtimeMap.set(kernelId, {
      wsStatus: "disconnected",
    });
  };
  socket.onerror = (err) => {
    console.log("Kernel socket error", err);
  };

  const resultMap = rootMap.get("resultMap") as Y.Map<PodResult>;
  socket.onmessage = (msg) => {
    console.log("Kernel socket message");
    let { type, payload } = JSON.parse(msg.data as string);
    switch (type) {
      case "stream":
        {
          let { podId, content } = payload;
          const oldresult: PodResult = resultMap.get(podId) || { data: [] };
          // FIXME if I modify the object, would it modify resultMap as well?
          oldresult.data.push({
            type: `${type}_${content.name}`,
            text: content.text,
          });
          resultMap.set(podId, oldresult);
        }
        break;
      case "execute_result":
        {
          let { podId, content, count } = payload;
          const oldresult: PodResult = resultMap.get(podId) || { data: [] };
          oldresult.data.push({
            type,
            text: content.data["text/plain"],
            html: content.data["text/html"],
          });
          resultMap.set(podId, oldresult);
        }
        break;
      case "display_data":
        {
          let { podId, content } = payload;
          const oldresult: PodResult = resultMap.get(podId) || { data: [] };
          oldresult.data.push({
            type,
            text: content.data["text/plain"],
            image: content.data["image/png"],
            html: content.data["text/html"],
          });
          resultMap.set(podId, oldresult);
        }
        break;
      case "execute_reply":
        {
          let { podId, result, count } = payload;
          const oldresult: PodResult = resultMap.get(podId) || { data: [] };
          oldresult.running = false;
          oldresult.lastExecutedAt = Date.now();
          oldresult.exec_count = count;
          resultMap.set(podId, oldresult);
        }
        break;
      case "error":
        {
          let { podId, ename, evalue, stacktrace } = payload;
          const oldresult: PodResult = resultMap.get(podId) || { data: [] };
          oldresult.error = { ename, evalue, stacktrace };
        }
        break;
      case "status":
        {
          const { lang, status, id } = payload;
          // listen to messages
          runtimeMap.set(kernelId, { ...runtimeMap.get(kernelId), status });
          if (status === "idle") {
            // if the status is idle, set 1s timeout to close the kernel
            scheduleToClose(kernelId);
          } else {
            // if the status is not idle, clear the timeout
            cancelToClose(kernelId);
          }
        }
        break;
      case "interrupt_reply":
        // console.log("got interrupt_reply", payload);
        break;
      default:
        console.warn("WARNING unhandled message", { type, payload });
    }
  };
}

class Kernel {
  constructor({ kernelId, repoId, yjsUrl, yjsToken }) {
    this.kernelId = kernelId;
    this.repoId = repoId;
    this.yjsUrl = yjsUrl;
    this.yjsToken = yjsToken;
  }
  kernelId: string;
  repoId: string;
  yjsUrl: string;
  yjsToken: string;
  kernelInfo?: KernelInfo;
  socket?: WebSocket;
  async spawn() {
    const kernelInfo = await spawnRuntime(this.kernelId);
    this.kernelInfo = kernelInfo;
  }
  async connect({ ydoc }) {
    if (!this.kernelInfo) {
      throw new Error(
        `cannot find kernelInfo for kernel ${this.kernelId} in repo ${this.repoId}`
      );
    }
    const wsUrl = `ws://localhost:${this.kernelInfo.ws_port}`;
    console.log("Connecting to kernel", wsUrl);
    const socket = new WebSocket(wsUrl);
    setKernelWS({ socket, kernelId: this.kernelId, ydoc });
  }
}

class Repo {
  constructor({ repoId }) {
    this.repoId = repoId;
  }
  repoId: string;
  yjsUrl?: string;
  yjsToken?: string;
  provider: WebsocketProvider;
  kernelMap: Map<string, Kernel> = new Map();
  wsSet: Set<WebSocket> = new Set();
  async createKernel({ repoId, yjsUrl, yjsToken }) {
    const kernelId = `${repoId}-${Date.now()}`;
    const repo = manager.getRepo({ repoId });
    repo.yjsUrl = yjsUrl;
    repo.yjsToken = yjsToken;
    const kernel = new Kernel({
      kernelId,
      repoId,
      yjsUrl,
      yjsToken,
    });
    await kernel.spawn();
    repo.addKernel(kernel);
    return kernelId;
  }
  addKernel(kernel: Kernel) {
    this.kernelMap.set(kernel.kernelId, kernel);
  }
  removeKernel(kernel: Kernel) {
    this.kernelMap.delete(kernel.kernelId);
  }
  addWs(ws) {
    this.wsSet.add(ws);
  }
  removeWs(ws) {
    this.wsSet.delete(ws);
  }
  async getYjsProvider(): Promise<WebsocketProvider> {
    return new Promise((resolve, reject) => {
      if (this.provider) {
        resolve(this.provider);
        return;
      }
      const ydoc = new Y.Doc();
      const provider = new WebsocketProvider(this.yjsUrl, this.repoId, ydoc, {
        // resyncInterval: 2000,
        //
        // BC is more complex to track our custom Uploading status and SyncDone events.
        disableBc: true,
        params: {
          token: this.yjsToken,
          role: "runtime",
        },
        // IMPORTANT: import websocket, because we're running it in node.js
        WebSocketPolyfill: WebSocket as any,
      });
      provider.on("status", ({ status }) => {
        console.log("provider status", status);
      });
      provider.once("synced", () => {
        console.log("Provider synced");
        this.provider = provider;
        resolve(provider);
      });
      provider.on("close", () => {
        console.log("Provider closed");
        this.provider = undefined;
      });
      provider.connect();
    });
  }
  async closeYjsProvider() {
    this.provider?.close();
    this.provider = undefined;
  }
}

class Manager {
  repoMap: Map<string, Repo> = new Map();
  getRepo({ repoId }) {
    if (!this.repoMap.has(repoId)) {
      this.repoMap.set(repoId, new Repo({ repoId }));
    }
    return this.repoMap.get(repoId)!;
  }
}

export const manager = new Manager();

// export async function disconnectKernel({ kernelId }) {
//   // provider.close
//   const kernelInfo = kernelInfoMap.get(kernelId);
//   if (!kernelInfo) {
//     return;
//   }
//   await closeYjsProvider({ repoId: kernelInfo.repoId });
//   // kernel ws.close
//   if (kernelInfo.socket) {
//     kernelInfo.socket.close();
//   }
//   kernelInfo.socket = undefined;
// }

export async function connectKernel({
  repoId,
  kernelId,
}: {
  repoId: string;
  kernelId: string;
}) {
  // 1. provider connect
  const repo = manager.getRepo({ repoId });
  const kernel = repo.kernelMap.get(kernelId);
  if (!kernel) {
    throw new Error(`cannot find kernel ${kernelId} in repo ${repoId}`);
  }
  if (!kernel.kernelInfo) {
    throw new Error(
      `cannot find kernelInfo for kernel ${kernelId} in repo ${repoId}`
    );
  }
  // const kernelInfo = kernelInfoMap.get(kernelId)!;
  // const repo = getRepo({
  //   yjsUrl: kernelInfo.yjsUrl,
  //   repoId: kernelInfo.repoId,
  //   yjsToken: kernelInfo.yjsToken,
  // });
  const provider = await repo.getYjsProvider();
  const ydoc: Y.Doc = provider.doc;

  // 2. connect kernel ws
  kernel.connect({ ydoc });
}

const schedule = new Map();
function scheduleToClose(repoId) {
  schedule.set(
    repoId,
    setTimeout(() => {
      console.log("Closing repo sockets", repoId);
      // disconnectKernel({ kernelId });
    }, 1000)
  );
}

function cancelToClose(repoId) {
  const timeout = schedule.get(repoId);
  if (timeout) {
    clearTimeout(timeout);
  }
  schedule.delete(repoId);
}
