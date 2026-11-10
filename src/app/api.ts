import type { ChartDataset } from "../kernel/chart";
import type { Evaluation, LiftPlan, ResultState } from "../kernel/evaluate";
import type { DatasetContent } from "../kernel/validate";

export interface User {
  id: string;
  email: string;
  name: string;
}

interface Person {
  id: string;
  name: string;
}

export interface Revision {
  id: string;
  planId: string;
  rev: number;
  superseded: boolean;
  plan: LiftPlan;
  dataset: ChartDataset | null;
  inputsHash: string;
  evaluation: Evaluation;
  author: Person;
  createdAt: string;
  review: { by: Person; at: string } | null;
  approval: { by: Person; at: string; scope: string } | null;
}

export interface PlanSummary {
  id: string;
  name: string;
  description: string;
  rev: number;
  state: ResultState;
  reviewed: boolean;
  approved: boolean;
  author: string;
  updatedAt: string;
}

export interface HistoryEntry {
  rev: number;
  author: string;
  createdAt: string;
  reviewedBy: string | null;
  approvedBy: string | null;
  inputsHash: string;
}

export interface ChartRecord {
  dataset: ChartDataset;
  importedById: string;
}

export interface AuditEntry {
  seq: number;
  at: string;
  action: string;
  detail: string;
  hash: string;
  user: string | null;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      credentials: "same-origin",
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, "NETWORK", "Cannot reach the server. Check your connection and try again.");
  }
  const data: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const e = (data ?? {}) as { code?: string; message?: string };
    throw new ApiError(res.status, e.code ?? "ERROR", e.message ?? `The server returned an error (${res.status}).`);
  }
  return data as T;
}

export const api = {
  me: () => request<{ user: User | null; signupOpen: boolean }>("GET", "/api/me"),
  login: (email: string, password: string) => request<{ user: User }>("POST", "/api/auth/login", { email, password }),
  register: (input: { email: string; name: string; password: string; signupCode: string }) => request<{ user: User }>("POST", "/api/auth/register", input),
  logout: () => request<{ ok: true }>("POST", "/api/auth/logout"),
  charts: async (): Promise<ChartRecord[]> => {
    const { datasets } = await request<{ datasets: Array<ChartDataset & { importedById: string }> }>("GET", "/api/datasets");
    return datasets.map(({ importedById, ...dataset }) => ({ dataset, importedById }));
  },
  createChart: (content: DatasetContent) => request<{ dataset: ChartDataset }>("POST", "/api/datasets", content),
  updateChart: (id: string, content: DatasetContent) => request<{ dataset: ChartDataset }>("PUT", `/api/datasets/${id}`, content),
  approveChart: (id: string) => request<{ dataset: ChartDataset }>("POST", `/api/datasets/${id}/approve`),
  loadSyntheticChart: () => request<{ dataset: ChartDataset }>("POST", "/api/datasets/synthetic"),
  plans: () => request<{ plans: PlanSummary[] }>("GET", "/api/plans"),
  plan: (id: string) => request<{ latest: Revision; history: HistoryEntry[] }>("GET", `/api/plans/${id}`),
  saveRevision: (planId: string | null, plan: LiftPlan, datasetId: string | null) =>
    request<{ revision: Revision }>("POST", planId ? `/api/plans/${planId}/revisions` : "/api/plans", { plan, datasetId }),
  review: (revisionId: string) => request<{ revision: Revision }>("POST", `/api/revisions/${revisionId}/review`),
  approve: (revisionId: string) => request<{ revision: Revision }>("POST", `/api/revisions/${revisionId}/approve`),
  audit: () => request<{ entries: AuditEntry[]; firstBrokenSeq: number | null }>("GET", "/api/audit"),
};
