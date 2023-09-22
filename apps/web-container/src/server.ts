import { WebSocketServer } from "ws";

import express from "express";
import http from "http";

import jwt from "jsonwebtoken";
import { gql } from "apollo-server";

import { ApolloServer } from "apollo-server-express";

import { ApolloServerPluginLandingPageLocalDefault } from "apollo-server-core";

import Y from "yjs";
import { WebsocketProvider } from "@codepod/yjs/src/y-websocket";
import WebSocket from "ws";

import { connectSocket, runtime2socket, RuntimeInfo } from "./yjs-runtime";
import { repo } from "./manager";

interface TokenInterface {
  id: string;
}

const typeDefs = gql`
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
`;

export async function startAPIServer({ port }) {
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
    typeDefs,
    resolvers: {
      Query: {},
      Mutation: {
        setupResultServer: async (
          _,
          { repoId, yjsUrl, yjsToken },
          { userId }
        ) => {
          repo.repoId = repoId;
          repo.yjsUrl = yjsUrl;
          // Once created, it uses the single token. That means all users that
          // has access to the runtime have the same access.
          repo.yjsToken = yjsToken;
          return true;
        },
        createKernel: async (_, {}, { userId }) => {
          const kernelId = await repo.createKernel();
          return kernelId;
        },
        connectKernel: async (_, { kernelId }, { userId }) => {
          const kernel = repo.kernelMap.get(kernelId);
          if (!kernel) {
            throw new Error(`cannot find kernel ${kernelId}.`);
          }
          if (!kernel.kernelInfo) {
            throw new Error(`cannot find kernelInfo for kernel ${kernelId}`);
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
