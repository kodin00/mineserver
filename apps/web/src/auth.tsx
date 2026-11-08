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
  login(password: string): Promise<void>;
  logout(): Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  useEffect(() => {
    api("/api/auth/me")
      .then(() => setAuthenticated(true))
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
      async login(password) {
        await api("/api/auth/login", {
          method: "POST",
          ...jsonBody({ password }),
        });
        setAuthenticated(true);
      },
      async logout() {
        await api("/api/auth/logout", { method: "POST" }).catch(
          () => undefined,
        );
        setAuthenticated(false);
      },
    }),
    [authenticated],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useAuth must be used within AuthProvider");
  return value;
}
