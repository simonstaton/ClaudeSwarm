import { createContext, type ReactNode, useCallback, useContext, useRef, useState } from "react";

interface AuthContextType {
  token: string | null;
  login: (apiKey: string) => Promise<void>;
  logout: () => void;
  authFetch: (url: string, opts?: RequestInit) => Promise<Response>;
}

const AuthContext = createContext<AuthContextType | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [token, setToken] = useState<string | null>(() => sessionStorage.getItem("jwt"));
  const tokenRef = useRef(token);

  const login = useCallback(async (apiKey: string) => {
    const res = await fetch("/api/auth/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey }),
    });

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || "Authentication failed");
    }

    const { token: jwt } = await res.json();
    sessionStorage.setItem("jwt", jwt);
    tokenRef.current = jwt;
    setToken(jwt);
  }, []);

  const logout = useCallback(() => {
    sessionStorage.removeItem("jwt");
    tokenRef.current = null;
    setToken(null);
  }, []);

  const authFetch = useCallback(async (url: string, opts: RequestInit = {}) => {
    const currentToken = sessionStorage.getItem("jwt");
    const headers = new Headers(opts.headers);
    if (currentToken) {
      headers.set("Authorization", `Bearer ${currentToken}`);
    }
    const res = await fetch(url, { ...opts, headers });
    if (res.status === 401) {
      sessionStorage.removeItem("jwt");
      tokenRef.current = null;
      setToken(null);
    }
    return res;
  }, []);

  return <AuthContext.Provider value={{ token, login, logout, authFetch }}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be inside AuthProvider");
  return ctx;
}
