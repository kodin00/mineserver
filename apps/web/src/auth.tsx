import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { api, jsonBody, setUnauthorizedHandler } from "./api";

interface AuthContextValue {
  authenticated: boolean | null;
  role: "admin" | "player" | null;
  login(password: string, role: "admin" | "player"): Promise<void>;
  logout(): Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [role, setRole] = useState<"admin" | "player" | null>(null);
  useEffect(() => {
    api<{ role: "admin" | "player" }>("/api/auth/me")
      .then((session) => {
        setRole(session.role);
        setAuthenticated(true);
      })
      .catch(() => setAuthenticated(false));
  }, []);
  useEffect(() => {
    // Any 401 from a poller/tab means the session expired: flip to the login
    // screen instead of leaving the SPA rendering "Session expired" errors.
    setUnauthorizedHandler(() => setAuthenticated(false));
    return () => setUnauthorizedHandler(null);
  }, []);
  const value = useMemo<AuthContextValue>(
    () => ({
      authenticated,
      role,
      async login(password, role) {
        const session = await api<{ role: "admin" | "player" }>(
          "/api/auth/login",
          {
            method: "POST",
            ...jsonBody({ password, role }),
          },
        );
        setRole(session.role);
        setAuthenticated(true);
      },
      async logout() {
        await api("/api/auth/logout", { method: "POST" }).catch(
          () => undefined,
        );
        setRole(null);
        setAuthenticated(false);
      },
    }),
    [authenticated, role],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useAuth must be used within AuthProvider");
  return value;
}
