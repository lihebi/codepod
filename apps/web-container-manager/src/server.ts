import { WebSocketServer } from "ws";

import express from "express";
import http from "http";

import jwt from "jsonwebtoken";

import { ApolloServer } from "apollo-server-express";

import httpProxy from "http-proxy";

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
    createContainer: String
  }
`;

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
    typeDefs,
    resolvers: {
      Query: {},
      Mutation: {
        createContainer: async (_, __, { userId }) => {},
      },
    },
    plugins: [ApolloServerPluginLandingPageLocalDefault({ embed: true })],
  });
  const expapp = express();
  const http_server = http.createServer(expapp);
  // graphql api will be available at /graphql

  // ======
  // Setup http and WS proxy
  const proxy = httpProxy.createProxyServer({ ws: true });
  // proxy
  expapp.use("/container/:id", (req, res) => {
    const { url } = req.query;
    const containerId = req.params.id;
    proxy.web(req, res, { target: `http://${containerId}` }, function (error) {
      console.log("==Error", error);
    });
  });

  http_server.on("upgrade", (req, socket, head) => {
    if (!req.url) {
      return;
    }
    const containerId = req.url.split("/")[2];
    proxy.ws(
      req,
      socket,
      head,
      { target: `http://${containerId}` },
      function (error) {
        console.log("== Error", error);
      }
    );
  });
  // start the server
  await apollo.start();
  apollo.applyMiddleware({ app: expapp });
  http_server.listen({ port }, () => {
    console.log(`🚀 API server ready at http://localhost:${port}`);
  });
}
