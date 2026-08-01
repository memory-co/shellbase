import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  api,
  type AppDef,
  type EnvDoc,
  type Terminal,
  type WindowDoc,
  type WindowSummary,
} from "./api";

export function useWindowDoc(wid: string) {
  return useQuery({
    queryKey: ["window", wid],
    queryFn: () => api<WindowDoc>(`/api/windows/${wid}`),
  });
}

export function useWindowList() {
  return useQuery({
    queryKey: ["windows"],
    queryFn: () => api<{ windows: WindowSummary[] }>("/api/windows"),
    select: (d) => d.windows,
  });
}

export function useTerminals(window?: string) {
  const q = window ? `?window=${encodeURIComponent(window)}` : "";
  return useQuery({
    queryKey: ["terminals", window ?? "*"],
    queryFn: () => api<{ terminals: Terminal[] }>(`/api/terminals${q}`),
    select: (d) => d.terminals,
  });
}

export async function deleteTerminal(uri: string) {
  return api(`/api/terminals?uri=${encodeURIComponent(uri)}`, {
    method: "DELETE",
  });
}

export function useApps() {
  return useQuery({
    queryKey: ["apps"],
    queryFn: () => api<{ apps: AppDef[] }>("/api/apps"),
    select: (d) => d.apps,
    staleTime: 60_000,
  });
}

export function useEnv() {
  return useQuery({
    queryKey: ["env"],
    queryFn: () => api<EnvDoc>("/api/env"),
  });
}

export function usePutEnv() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: Record<string, string | null>) =>
      api("/api/env", { method: "PUT", body: JSON.stringify({ vars }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["env"] }),
  });
}
