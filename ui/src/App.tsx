import { NavLink, Routes, Route } from "react-router-dom";
import { AgentsPage } from "./pages/AgentsPage.js";
import { ActivityPage } from "./pages/ActivityPage.js";
import { ListenersPage } from "./pages/ListenersPage.js";
import { SchedulesPage } from "./pages/SchedulesPage.js";
import { ApprovalsPage } from "./pages/ApprovalsPage.js";
import { NewAgentPage } from "./pages/NewAgentPage.js";
import { HealthPill } from "./components/HealthPill.js";

const NAV = [
  { to: "/", label: "Agents", end: true },
  { to: "/activity", label: "Activity" },
  { to: "/listeners", label: "Listeners" },
  { to: "/schedules", label: "Schedules" },
  { to: "/approvals", label: "Approvals" },
];

export function App() {
  return (
    <div className="flex h-full">
      <aside className="flex w-60 shrink-0 flex-col border-r border-hades-border bg-hades-panel">
        <div className="flex items-center gap-2 px-5 py-5">
          <span className="text-2xl">🔥</span>
          <div>
            <div className="font-mono text-lg font-bold tracking-tight">Hades</div>
            <div className="text-[11px] text-slate-500">agent OS</div>
          </div>
        </div>
        <nav className="flex-1 space-y-1 px-3">
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) =>
                `block rounded-md px-3 py-2 text-sm font-medium transition-colors ${
                  isActive
                    ? "bg-hades-accent/15 text-hades-accent"
                    : "text-slate-300 hover:bg-slate-800 hover:text-white"
                }`
              }
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
        <div className="border-t border-hades-border p-3">
          <NavLink
            to="/new"
            className="block rounded-md bg-hades-accent px-3 py-2 text-center text-sm font-semibold text-white transition-colors hover:bg-orange-600"
          >
            + New Agent
          </NavLink>
        </div>
        <div className="px-4 py-3">
          <HealthPill />
        </div>
      </aside>
      <main className="flex-1 overflow-auto">
        <Routes>
          <Route path="/" element={<AgentsPage />} />
          <Route path="/activity" element={<ActivityPage />} />
          <Route path="/listeners" element={<ListenersPage />} />
          <Route path="/schedules" element={<SchedulesPage />} />
          <Route path="/approvals" element={<ApprovalsPage />} />
          <Route path="/new" element={<NewAgentPage />} />
        </Routes>
      </main>
    </div>
  );
}
