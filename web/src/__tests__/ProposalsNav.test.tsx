/**
 * AI-2040 (P4-C5) — nav entry, pending-count badge, and route reachability.
 *
 * This file covers the half of AC5.1 that ProposalsPage.test.tsx cannot:
 *
 *   AC5.1  "New dedicated page /admin/proposals with its own nav entry and
 *           pending-count badge"
 *
 * The route-reachability test is the guard against the AI-1954 failure class
 * (a component that exists with green tests but is imported nowhere). It renders
 * the real <App /> — the production entry point for the console bundle — at
 * /admin/proposals and asserts the page actually mounts. A ProposalsPage unit
 * test alone would pass even if App.tsx never routed to it.
 *
 * Note the router's basename is "/admin", so the AC's `/admin/proposals` URL is
 * the route path "/proposals" inside <BrowserRouter basename="/admin">.
 *
 * CONTRACT ADDED HERE:
 *   <Tabs pendingProposals={number} /> — optional; renders a badge on the
 *   Proposals nav entry when the count is > 0, and no badge when it is 0.
 *
 * Tests fail until Tabs gains the Proposals entry and App.tsx routes /proposals.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { Tabs } from "../components";
import { App } from "../App";

/**
 * The console bundle boots against the admin API. Everything the shell needs to
 * reach an authenticated render is stubbed; the proposals payload drives the badge.
 */
function mockApi(pendingCount: number) {
  const proposals = Array.from({ length: pendingCount }, (_, i) => ({
    id: `p-${i}`,
    title: `Pending proposal ${i}`,
    workflowId: "dev-impl",
    stateId: "write-tests",
    status: "pending",
    severity: "HIGH",
    confidenceScore: 0.87,
    createdAt: new Date().toISOString(),
    diffStat: { added: 1, removed: 0 },
    diffs: [],
    evidence: [],
    failureCount: 3,
    version: 1,
    revisions: [],
  }));

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const json = url.includes("/me")
        ? { authenticated: true, secretConfigured: true }
        : url.includes("proposal")
          ? { proposals }
          // Enough shape for the other console pages to render without throwing, so a
          // missing /proposals route fails this file's assertions rather than crashing
          // inside whatever page the "*" fallback redirects to.
          : { attention: [], alerts: [], agents: [], webhooks: [] };
      return new Response(JSON.stringify(json), { status: 200, headers: { "Content-Type": "application/json" } });
    }),
  );

  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  );
}

beforeEach(() => {
  window.history.pushState({}, "", "/admin/proposals");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.history.pushState({}, "", "/");
});

describe("AI-2040 AC5.1: Proposals nav entry", () => {
  it("renders a Proposals entry pointing at /proposals", () => {
    render(
      <MemoryRouter>
        <Tabs />
      </MemoryRouter>,
    );
    expect(screen.getByRole("link", { name: /proposals/i })).toHaveAttribute("href", "/proposals");
  });

  it("shows the pending count as a badge on the nav entry", () => {
    render(
      <MemoryRouter>
        <Tabs pendingProposals={3} />
      </MemoryRouter>,
    );
    const link = screen.getByRole("link", { name: /proposals/i });
    expect(within(link).getByTestId("nav-pending-badge")).toHaveTextContent("3");
  });

  it("renders no badge when nothing is pending", () => {
    render(
      <MemoryRouter>
        <Tabs pendingProposals={0} />
      </MemoryRouter>,
    );
    // Anchor on the nav entry first — asserting only the badge's absence would pass
    // against a Tabs component that has no Proposals entry at all.
    const link = screen.getByRole("link", { name: /proposals/i });
    expect(within(link).queryByTestId("nav-pending-badge")).toBeNull();
  });
});

describe("AI-2040 AC5.1: /admin/proposals is reachable in the live bundle (AI-1954 guard)", () => {
  it("mounts ProposalsPage when App boots at /admin/proposals", async () => {
    mockApi(0);
    render(<App />);
    expect(await screen.findByTestId("proposals-layout")).toBeInTheDocument();
  });

  it("links to the page from the console nav", async () => {
    mockApi(0);
    render(<App />);
    const link = await screen.findByRole("link", { name: /proposals/i });
    expect(link).toHaveAttribute("href", "/admin/proposals");
  });

  it("drives the nav badge from the real pending-proposal count", async () => {
    mockApi(2);
    render(<App />);
    expect(await screen.findByTestId("nav-pending-badge")).toHaveTextContent("2");
  });
});
