/**
 * approval.ts — run fingerprint and approval rules.
 *
 * An approval is bound to the SHA-256 of the exact inputs it was given for:
 * plan, chart dataset and kernel version. Change any of them and the
 * fingerprint changes, so the approval no longer applies.
 */
import type { ChartDataset } from "./chart";
import { type Evaluation, KERNEL_VERSION, type LiftPlan } from "./evaluate";

/** JSON with object keys sorted, so equal content always serializes identically. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .filter((k) => obj[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`)
    .join(",")}}`;
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export function fingerprintInput(plan: LiftPlan, dataset: ChartDataset | null, gravity: number): string {
  return canonicalJson({ kernelVersion: KERNEL_VERSION, gravity, plan, dataset });
}

export interface Approval {
  inputsHash: string;
  author: string;
  reviewer: string;
  approver: string;
  scope: string;
  approvedAt: string;
}

export interface ApprovalCheck {
  ok: boolean;
  problems: string[];
}

export function canApprove(evaluation: Evaluation, people: Pick<Approval, "author" | "reviewer" | "approver">): ApprovalCheck {
  const problems: string[] = [];
  if (evaluation.state !== "WITHIN_LIMITS") problems.push("Every check must be calculated within stated limits, with nothing left for review.");
  if (evaluation.synthetic) problems.push("The chart dataset is synthetic test data and cannot support an approved plan.");
  const names = [people.author, people.reviewer, people.approver].map((n) => n.trim().toLowerCase());
  if (names.some((n) => n === "")) problems.push("Author, reviewer and approver must all be named.");
  else if (new Set(names).size !== 3) problems.push("Author, reviewer and approver must be three different people.");
  return { ok: problems.length === 0, problems };
}

export type ApprovalStatus = "none" | "current" | "invalidated";

export function approvalStatus(approval: Approval | null, currentInputsHash: string | null): ApprovalStatus {
  if (!approval) return "none";
  return approval.inputsHash === currentInputsHash ? "current" : "invalidated";
}
