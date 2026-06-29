import { Navigate, Route, Routes } from "react-router-dom";
import { LoaderCircle } from "lucide-react";
import { useAuth } from "./auth";
import { LoginPage } from "./pages/LoginPage";
import { DashboardPage } from "./pages/DashboardPage";
import { CreateServerPage } from "./pages/CreateServerPage";
import { ServerPage } from "./pages/ServerPage";
import { AccountPage } from "./pages/AccountPage";

function ProtectedRoutes() {
  const { authenticated } = useAuth();
  if (authenticated === null) {
    return (
      <div className="screen-center">
        <LoaderCircle className="spin" size={28} />
      </div>
    );
  }
  if (!authenticated) return <Navigate to="/login" replace />;
  return (
    <Routes>
      <Route path="/" element={<DashboardPage />} />
      <Route path="/servers/new" element={<CreateServerPage />} />
      <Route path="/servers/:id" element={<ServerPage />} />
      <Route path="/account" element={<AccountPage />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/*" element={<ProtectedRoutes />} />
    </Routes>
  );
}
