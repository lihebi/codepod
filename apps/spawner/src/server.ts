import { WebSocketServer } from "ws";

import express from "express";
import http from "http";

import jwt from "jsonwebtoken";

import { ApolloServer } from "apollo-server-express";

import { gql } from "apollo-server";
import { ApolloServerPluginLandingPageLocalDefault } from "apollo-server-core";

import Y from "yjs";
import { WebsocketProvider } from "@codepod/yjs/src/y-websocket";
import WebSocket from "ws";

import { connectSocket, runtime2socket, RuntimeInfo } from "./yjs-runtime";
import { connectKernel, createKernel, getRepo, manager } from "./manager";

interface TokenInterface {
  id: string;
}

// This runtime server needs to maintain a connection to Yjs server

// const yjsServerUrl = "ws://localhost:4010";
// const yjsServerUrl = `ws://${process.env.YJS_SERVER_HOST}:${process.env.YJS_SERVER_PORT}`
if (!process.env.YJS_WS_URL) throw new Error("YJS_WS_URL is not set.");
const yjsServerUrl = process.env.YJS_WS_URL;

// FIXME need to have a TTL to clear the ydoc.
const docs: Map<string, Y.Doc> = new Map();

async function getMyYDoc({ repoId, token }): Promise<Y.Doc> {
  return new Promise((resolve, reject) => {
    const oldydoc = docs.get(repoId);
    if (oldydoc) {
      resolve(oldydoc);
      return;
    }
    const ydoc = new Y.Doc();
    // connect to primary database
    console.log("connecting to y-websocket provider", yjsServerUrl);
    const provider = new WebsocketProvider(yjsServerUrl, repoId, ydoc, {
      // resyncInterval: 2000,
      //
      // BC is more complex to track our custom Uploading status and SyncDone events.
      disableBc: true,
      params: {
        token,
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
      docs.set(repoId, ydoc);
      resolve(ydoc);
    });
    provider.connect();
  });
}

const routingTable: Map<string, string> = new Map();

export async function startAPIServer({ port, spawnRuntime, killRuntime }) {
  const apollo = new ApolloServer({
    context: ({ req }) => {
      const token = req?.headers?.authorization?.slice(7);
      let userId;

      if (token) {
        const decoded = jwt.verify(
          token,
          process.env.JWT_SECRET as string
        ) as TokenInterface;
        userId = decoded.id;
      }
      return {
        userId,
        token,
      };
    },
    typeDefs: gql`
      type RouteInfo {
        url: String
        lastActive: String
      }

      input RunSpecInput {
        code: String
        podId: String
      }

      type Query {
        hello: String
      }

      type Mutation {
        createKernel(
          runtimeId: String
          repoId: String
          yjsUrl: String
          yjsToken: String
        ): Boolean
        connectKernel(kernelId: String): Boolean
        disconnectKernel(kernelId: String): Boolean

        # spawnRuntime(runtimeId: String, repoId: String): Boolean
        # killRuntime(runtimeId: String, repoId: String): Boolean

        # connectRuntime(runtimeId: String, repoId: String): Boolean
        # disconnectRuntime(runtimeId: String, repoId: String): Boolean
        # runCode(runtimeId: String, spec: RunSpecInput): Boolean
        # runChain(runtimeId: String, specs: [RunSpecInput]): Boolean
        # interruptKernel(runtimeId: String): Boolean
        # requestKernelStatus(runtimeId: String): Boolean
      }
    `,
    resolvers: {
      Query: {},
      Mutation: {
        createKernel: async (_, { repoId, yjsUrl, yjsToken }, { userId }) => {
          const repo = manager.getRepo({ repoId });
          // FIXME a different user would change the yjsToken
          repo.yjsUrl = yjsUrl;
          repo.yjsToken = yjsToken;
          const kernelId = await repo.createKernel({
            repoId,
            yjsUrl,
            yjsToken,
          });
          return kernelId;
        },
        connectKernel: async (_, { kernelId }, { userId }) => {
          await connectKernel({ kernelId });
          return true;
        },
        // disconnectKernel: async (_, { kernelId }, { userId }) => {
        //   await disconnectKernel({ kernelId });
        //   return true;
        // },

        spawnRuntime: async (_, { runtimeId, repoId }, { token, userId }) => {
          // TODO verify repoId is owned by userId
          if (!userId) throw new Error("Not authorized.");
          // create the runtime container
          const runtimeInfo = await spawnRuntime(runtimeId);
          // kernelInfoMap.set(runtimeId, runtimeInfo);
          const wsUrl = `ws://localhost:${runtimeId.ws_port}`;
          console.log("Runtime spawned at", wsUrl);
          routingTable.set(runtimeId, wsUrl);
          // set initial runtimeMap info for this runtime
          console.log("Loading yDoc ..");
          const doc = await getMyYDoc({ repoId, token });
          console.log("yDoc loaded");
          const rootMap = doc.getMap("rootMap");
          const runtimeMap = rootMap.get("runtimeMap") as Y.Map<RuntimeInfo>;
          runtimeMap.set(runtimeId, {});
          return true;
        },
        killRuntime: async (_, { runtimeId, repoId }, { token, userId }) => {
          if (!userId) throw new Error("Not authorized.");
          // const info = kernelInfoMap.get(runtimeId);
          // if (!info) {
          //   console.warn(`WARN Runtime ${runtimeId} not found`);
          //   return;
          // }
          // kernelInfoMap.delete(runtimeId);
          // await killRuntime(info);
          console.log("Removing route ..");
          // remove from runtimeMap
          const doc = await getMyYDoc({ repoId, token });
          const rootMap = doc.getMap("rootMap");
          const runtimeMap = rootMap.get("runtimeMap") as Y.Map<RuntimeInfo>;
          runtimeMap.delete(runtimeId);
          routingTable.delete(runtimeId);
          return true;
        },

        connectRuntime: async (_, { runtimeId, repoId }, { token, userId }) => {
          if (!userId) throw new Error("Not authorized.");
          console.log("=== connectRuntime", runtimeId, repoId);
          // assuming doc is already loaded.
          // FIXME this socket/ is the prefix of url. This is very prone to errors.
          const doc = await getMyYDoc({ repoId, token });
          const rootMap = doc.getMap("rootMap");
          console.log("rootMap", Array.from(rootMap.keys()));
          const runtimeMap = rootMap.get("runtimeMap") as any;
          const resultMap = rootMap.get("resultMap") as any;
          await connectSocket({
            runtimeId,
            runtimeMap,
            resultMap,
            routingTable,
          });
        },
        disconnectRuntime: async (
          _,
          { runtimeId, repoId },
          { token, userId }
        ) => {
          if (!userId) throw new Error("Not authorized.");
          console.log("=== disconnectRuntime", runtimeId);
          // get socket
          const socket = runtime2socket.get(runtimeId);
          if (socket) {
            socket.close();
            runtime2socket.delete(runtimeId);
          }

          const doc = await getMyYDoc({ repoId, token });
          const rootMap = doc.getMap("rootMap");
          const runtimeMap = rootMap.get("runtimeMap") as Y.Map<RuntimeInfo>;
          runtimeMap.set(runtimeId, {});
        },
        runCode: async (
          _,
          { runtimeId, spec: { code, podId } },
          { userId }
        ) => {
          if (!userId) throw new Error("Not authorized.");
          console.log("runCode", runtimeId, podId);
          const socket = runtime2socket.get(runtimeId);
          if (!socket) return false;
          // clear old results
          // TODO move this to frontend, because it is hard to get ydoc in GraphQL handler.
          //
          // console.log("clear old result");
          // console.log("old", resultMap.get(runtimeId));
          // resultMap.set(podId, { data: [] });
          // console.log("new", resultMap.get(runtimeId));
          // console.log("send new result");
          socket.send(
            JSON.stringify({
              type: "runCode",
              payload: {
                lang: "python",
                code: code,
                raw: true,
                podId: podId,
                sessionId: runtimeId,
              },
            })
          );
          return true;
        },
        runChain: async (_, { runtimeId, specs }, { userId }) => {
          if (!userId) throw new Error("Not authorized.");
          console.log("runChain", runtimeId, specs.podId);
          const socket = runtime2socket.get(runtimeId);
          if (!socket) return false;
          specs.forEach(({ code, podId }) => {
            socket.send(
              JSON.stringify({
                type: "runCode",
                payload: {
                  lang: "python",
                  code: code,
                  raw: true,
                  podId: podId,
                  sessionId: runtimeId,
                },
              })
            );
          });
          return true;
        },
        interruptKernel: async (_, { runtimeId }, { userId }) => {
          if (!userId) throw new Error("Not authorized.");
          const socket = runtime2socket.get(runtimeId);
          if (!socket) return false;
          socket.send(
            JSON.stringify({
              type: "interruptKernel",
              payload: {
                sessionId: runtimeId,
              },
            })
          );
          return true;
        },
        requestKernelStatus: async (_, { runtimeId }, { userId }) => {
          if (!userId) throw new Error("Not authorized.");
          console.log("requestKernelStatus", runtimeId);
          const socket = runtime2socket.get(runtimeId);
          if (!socket) {
            console.log("WARN: socket not found");
            return false;
          }
          socket.send(
            JSON.stringify({
              type: "requestKernelStatus",
              payload: {
                sessionId: runtimeId,
              },
            })
          );
          return true;
        },
      },
    },
    plugins: [ApolloServerPluginLandingPageLocalDefault({ embed: true })],
  });
  const expapp = express();
  const http_server = http.createServer(expapp);
  // graphql api will be available at /graphql

  // ws
  const wss = new WebSocketServer({ noServer: true });
  wss.on("connection", (ws, request) => {
    console.log("ws connected");
    // get repo ID
    const url = new URL(`ws://${request.headers.host}${request.url}`);
    if (request.url) {
      const docName = request.url.slice(1).split("?")[0];
      const token = url.searchParams.get("token");
      const repoId = docName.split("/")[1];
      console.log("repoId", repoId);
      const repo = getRepo({ repoId });
      repo.addWs(ws);
      ws.onclose = () => {
        console.log("ws closed");
        repo.removeWs(ws);
        if (repo.wsSet?.size === 0) {
          // FIXME wait for kernel to be idle
          console.log("TODO no more ws for this repo, closing yjs connection");
          // disconnectKernel({ kernelId: repoId });
        }
      };
    } else {
      throw new Error("request.url is undefined");
    }
  });

  await apollo.start();
  apollo.applyMiddleware({ app: expapp });
  http_server.listen({ port }, () => {
    console.log(`🚀 API server ready at http://localhost:${port}`);
  });
}