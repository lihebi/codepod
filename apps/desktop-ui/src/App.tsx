import "@codepod/ui/src/App.css";
import "@codepod/ui/src/custom.css";

import {
  createBrowserRouter,
  createRoutesFromElements,
  Route,
  RouterProvider,
} from "react-router-dom";

import { createTheme, ThemeProvider } from "@mui/material/styles";

import { Dashboard, Repo, Test } from "@codepod/ui";

import { Header, Footer } from "@codepod/ui";
import { AuthProvider } from "./lib/auth";

import Link from "@mui/material/Link";
import { Link as ReactLink } from "react-router-dom";

import Box from "@mui/material/Box";
import { SnackbarProvider } from "notistack";
import { Typography } from "@mui/material";

const yjsWsUrl = import.meta.env.VITE_APP_YJS_WS_URL;
const apiUrl = import.meta.env.VITE_APP_API_URL;
const spawnerApiUrl = import.meta.env.VITE_APP_SPAWNER_API_URL;

if (!yjsWsUrl) {
  throw new Error("VITE_APP_YJS_WS_URL is not defined");
}
if (!apiUrl) {
  throw new Error("VITE_APP_API_URL is not defined");
}
if (!spawnerApiUrl) {
  throw new Error("VITE_APP_RUNTIME_API_URL is not defined");
}

const theme = createTheme({
  typography: {
    button: {
      textTransform: "none",
    },
  },
});

const NormalLayout = ({ children }) => {
  return (
    <Box>
      <Header>
        <Box
          sx={{
            alignItems: "baseline",
            display: "flex",
            flexGrow: 1,
          }}
        >
          <Link component={ReactLink} underline="hover" to="/">
            <Typography noWrap>CodePod</Typography>
          </Link>
        </Box>
      </Header>
      <Box pt="50px">{children}</Box>
      {/* <Footer /> */}
    </Box>
  );
};

const router = createBrowserRouter([
  {
    path: "repo/:id",
    element: (
      <Box height="100vh" width="100%" boxSizing={"border-box"}>
        <Repo yjsWsUrl={yjsWsUrl} />
      </Box>
    ),
  },
  {
    path: "test",
    element: (
      <NormalLayout>
        <Test />
      </NormalLayout>
    ),
  },
  {
    path: "/",
    element: (
      <NormalLayout>
        <Dashboard />
      </NormalLayout>
    ),
  },
]);

export default function App() {
  return (
    <ThemeProvider theme={theme}>
      <AuthProvider apiUrl={apiUrl} spawnerApiUrl={spawnerApiUrl}>
        <SnackbarProvider maxSnack={5}>
          <RouterProvider router={router} />
        </SnackbarProvider>
      </AuthProvider>
    </ThemeProvider>
  );
}
