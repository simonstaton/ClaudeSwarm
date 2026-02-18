import { Component, type ErrorInfo, type ReactNode } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { AuthProvider, useAuth } from "./auth";
import { KillSwitchBanner } from "./components/KillSwitchBanner";
import { useKillSwitch } from "./hooks/useKillSwitch";
import { AgentView } from "./pages/AgentView";
import { Dashboard } from "./pages/Dashboard";
import { Login } from "./pages/Login";
import { Settings } from "./pages/Settings";

class ErrorBoundary extends Component<{ children: ReactNode }, { hasError: boolean; error: Error | null }> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[ErrorBoundary]", error, info.componentStack);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="h-screen flex items-center justify-center bg-zinc-950 text-zinc-100">
          <div className="text-center max-w-md px-6">
            <h1 className="text-xl font-semibold mb-2">Something went wrong</h1>
            <p className="text-sm text-zinc-400 mb-4">{this.state.error?.message || "An unexpected error occurred."}</p>
            <button
              type="button"
              className="px-4 py-2 text-sm bg-zinc-800 hover:bg-zinc-700 rounded-md transition-colors"
              onClick={() => {
                this.setState({ hasError: false, error: null });
                window.location.href = "/";
              }}
            >
              Reload
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { token } = useAuth();
  if (!token) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

/** Provides kill switch state to all protected pages via a shared layout. */
function AppLayout({ children }: { children: React.ReactNode }) {
  const ks = useKillSwitch();
  return (
    <div className="h-screen flex flex-col overflow-hidden">
      <KillSwitchBanner
        state={ks.state}
        loading={ks.loading}
        onDeactivate={ks.deactivate}
      />
      {/* Pass kill switch context to children via cloneElement pattern would be complex;
          instead pages import useKillSwitch() themselves for the panic button.
          The banner lives here (shared) so it appears on every page. */}
      <div className="flex-1 overflow-hidden">
        {children}
      </div>
    </div>
  );
}

function AppRoutes() {
  const { token } = useAuth();

  return (
    <Routes>
      <Route path="/login" element={token ? <Navigate to="/" replace /> : <Login />} />
      <Route
        path="/"
        element={
          <ProtectedRoute>
            <AppLayout>
              <Dashboard />
            </AppLayout>
          </ProtectedRoute>
        }
      />
      <Route
        path="/agents/:id"
        element={
          <ProtectedRoute>
            <AppLayout>
              <AgentView />
            </AppLayout>
          </ProtectedRoute>
        }
      />
      <Route
        path="/settings"
        element={
          <ProtectedRoute>
            <AppLayout>
              <Settings />
            </AppLayout>
          </ProtectedRoute>
        }
      />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export function App() {
  return (
    <ErrorBoundary>
      <BrowserRouter>
        <AuthProvider>
          <AppRoutes />
        </AuthProvider>
      </BrowserRouter>
    </ErrorBoundary>
  );
}
