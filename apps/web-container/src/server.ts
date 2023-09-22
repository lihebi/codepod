import { WebSocketServer } from "ws";

import express from "express";
import http from "http";

import jwt from "jsonwebtoken";
import { gql } from "apollo-server";

import { ApolloServer } from "apollo-server-express";

import { ApolloServerPluginLandingPageLocalDefault } from "apollo-server-core";

import { manager } from "./manager";

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
  }
`;

function getKernelSocket(kernelId: string) {
  const kernel = manager.kernelMap.get(kernelId);
  if (!kernel) throw new Error(`Cannot find kernel ${kernelId}`);
  if (!kernel.socket)
    throw new Error(`Cannot find socket for kernel ${kernelId}`);
  return kernel.socket;
}

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
          await manager.connectYjsProvider({
            repoId,
            yjsUrl,
            yjsToken,
          });
          return true;
        },
        /**
         * Create the kernel if not exists. Then connect to the kernel.
         * @param _
         * @param param1
         * @param param2
         * @returns
         */
        connectKernel: async (_, { kernelId }, { userId }) => {
          if (!manager.provider) {
            throw new Error("Yjs provider is not ready.");
          }
          if (!manager.kernelMap.has(kernelId)) {
            console.log(
              `Cannot find kernel ${kernelId}. Creating a new kernel ..`
            );
            await manager.createKernel(kernelId);
          }
          const kernel = manager.kernelMap.get(kernelId)!;
          // 2. connect kernel ws
          const ydoc = manager.provider.doc;
          kernel.connect({ ydoc });
        },

        runCode: async (
          _,
          { runtimeId, spec: { code, podId } },
          { userId }
        ) => {
          if (!userId) throw new Error("Not authorized.");
          console.log("runCode", runtimeId, podId);
          const socket = getKernelSocket(runtimeId);
          // clear old results
          // TODO move this to frontend, because it is hard to get ydoc in GraphQL handler.
          //
          // UPDATE 2023-09-23: maybe move this here again, as it's easy to get ydoc now.
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
          const socket = getKernelSocket(runtimeId);
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
          const socket = getKernelSocket(runtimeId);
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
          const socket = getKernelSocket(runtimeId);
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

  await apollo.start();
  apollo.applyMiddleware({ app: expapp });
  http_server.listen({ port }, () => {
    console.log(`🚀 API server ready at http://localhost:${port}`);
  });
}
