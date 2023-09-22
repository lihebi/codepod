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
  constructor({ kernelId }) {
    this.kernelId = kernelId;
  }
  kernelId: string;
  kernelInfo?: KernelInfo;
  socket?: WebSocket;
  async spawn() {
    const kernelInfo = await spawnRuntime(this.kernelId);
    this.kernelInfo = kernelInfo;
  }
  async connect({ ydoc }) {
    if (!this.kernelInfo) {
      throw new Error(`cannot find kernelInfo for kernel ${this.kernelId}`);
    }
    const wsUrl = `ws://localhost:${this.kernelInfo.ws_port}`;
    console.log("Connecting to kernel", wsUrl);
    const socket = new WebSocket(wsUrl);
    setKernelWS({ socket, kernelId: this.kernelId, ydoc });
  }
}

class Repo {
  constructor() {}
  repoId?: string;
  yjsUrl?: string;
  yjsToken?: string;
  provider: WebsocketProvider;
  kernelMap: Map<string, Kernel> = new Map();
  wsSet: Set<WebSocket> = new Set();
  async createKernel() {
    if (!this.repoId) {
      throw new Error("repoId is not set");
    }
    const kernelId = `${this.repoId}-${Date.now()}`;
    const kernel = new Kernel({
      kernelId,
    });
    await kernel.spawn();
    this.addKernel(kernel);
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

export const repo = new Repo();
