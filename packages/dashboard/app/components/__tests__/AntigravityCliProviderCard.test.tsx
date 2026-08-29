import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { AntigravityCliProviderCard } from "../AntigravityCliProviderCard";

const fetchAntigravityCliStatus = vi.fn();
const setAntigravityCliBinaryPath = vi.fn();
const setAntigravityCliEnabled = vi.fn();
const setAntigravityCliPermissionMode = vi.fn();

vi.mock("../../api", () => ({
  fetchAntigravityCliStatus: (...args: unknown[]) => fetchAntigravityCliStatus(...args),
  setAntigravityCliBinaryPath: (...args: unknown[]) => setAntigravityCliBinaryPath(...args),
  setAntigravityCliEnabled: (...args: unknown[]) => setAntigravityCliEnabled(...args),
  setAntigravityCliPermissionMode: (...args: unknown[]) => setAntigravityCliPermissionMode(...args),
}));

const baseStatus = {
  binary: {
    available: true,
    authenticated: true,
    version: "1.0.0",
    binaryPath: "/usr/local/bin/agy",
    probeDurationMs: 5,
  },
  enabled: true,
  binaryPath: "/usr/local/bin/agy",
  permissionMode: "skip" as const,
  extension: null,
  ready: true,
};

/*
FNXC:AntigravityCli 2026-07-18-18:10:
Regression coverage mirroring GrokCliProviderCard.test.tsx. The compact card's
below-header content (status line + binary-path control) must be nested inside
`.antigravity-cli-provider-card__body` (data-testid="antigravity-cli-provider-card-body")
rather than being a bare direct child of `.auth-provider-card`. The non-compact
onboarding layout must NOT render this wrapper. Unlike Grok, Antigravity uses a
subscription hint (not apiKeyDetected) when the binary is available.
*/
describe("AntigravityCliProviderCard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchAntigravityCliStatus.mockResolvedValue(baseStatus);
    setAntigravityCliEnabled.mockResolvedValue({
      enabled: true,
      binaryPath: baseStatus.binaryPath,
      restartRequired: true,
    });
    setAntigravityCliBinaryPath.mockResolvedValue({
      enabled: true,
      binaryPath: baseStatus.binaryPath,
      permissionMode: "skip",
      restartRequired: true,
    });
    setAntigravityCliPermissionMode.mockResolvedValue({
      enabled: true,
      binaryPath: baseStatus.binaryPath,
      permissionMode: "sandbox",
      restartRequired: false,
    });
  });

  it("wraps compact status line + binary-path control in the padded body wrapper", async () => {
    render(<AntigravityCliProviderCard authenticated compact />);

    const body = await screen.findByTestId("antigravity-cli-provider-card-body");
    expect(body).toHaveClass("antigravity-cli-provider-card__body");

    const status = await screen.findByText(/Connected/i);
    expect(body).toContainElement(status);

    const label = screen.getByText("Antigravity CLI binary path");
    expect(body).toContainElement(label);
    const input = screen.getByLabelText("Antigravity CLI binary path");
    expect(body).toContainElement(input);

    const permission = screen.getByTestId("antigravity-cli-permission-mode");
    expect(body).toContainElement(permission);

    const card = screen.getByTestId("antigravity-cli-provider-card");
    expect(card).toContainElement(body);
  });

  it("saves permission mode changes from the compact card select", async () => {
    const { default: userEvent } = await import("@testing-library/user-event");
    const user = userEvent.setup();
    render(<AntigravityCliProviderCard authenticated compact />);

    const select = await screen.findByTestId("antigravity-cli-permission-mode");
    await user.selectOptions(select, "sandbox");

    await waitFor(() => {
      expect(setAntigravityCliPermissionMode).toHaveBeenCalledWith("sandbox");
    });
  });

  it("keeps the body wrapper present before the status probe resolves (Probing…)", async () => {
    fetchAntigravityCliStatus.mockReturnValue(new Promise(() => {}));
    render(<AntigravityCliProviderCard authenticated={false} compact />);

    const body = await screen.findByTestId("antigravity-cli-provider-card-body");
    const status = await screen.findByText(/Probing local CLI/i);
    expect(body).toContainElement(status);
  });

  /*
  FNXC:AntigravityCli 2026-07-18-18:10:
  When the binary is available, the card must surface a subscription hint about
  Antigravity subscription / local `agy` CLI — not an API-key gate. Fusion does
  not require a Gemini API key; auth stays in the Antigravity CLI.
  */
  it("shows a subscription hint about Antigravity subscription / agy CLI when the binary is available", async () => {
    render(<AntigravityCliProviderCard authenticated compact />);

    const status = await screen.findByText(/Connected/i);
    expect(status).toBeInTheDocument();

    const hint = await screen.findByText(/Antigravity subscription/i);
    expect(hint.textContent).toMatch(/agy/i);
    expect(hint.textContent).toMatch(/no Gemini API key/i);
  });

  it("does not show the subscription hint when the binary is unavailable", async () => {
    fetchAntigravityCliStatus.mockResolvedValue({
      ...baseStatus,
      binary: { ...baseStatus.binary, available: false, reason: "`agy` not found on PATH" },
      ready: false,
    });

    render(<AntigravityCliProviderCard authenticated={false} compact />);

    await screen.findByText(/`agy` not found on PATH/i);
    expect(screen.queryByText(/Antigravity subscription/i)).not.toBeInTheDocument();
  });

  it("keeps the body wrapper present when a pathMessage is shown after a failed save", async () => {
    setAntigravityCliBinaryPath.mockRejectedValueOnce(new Error("binary not found"));
    const { default: userEvent } = await import("@testing-library/user-event");
    const user = userEvent.setup();

    render(<AntigravityCliProviderCard authenticated compact />);
    const input = await screen.findByLabelText("Antigravity CLI binary path");
    await user.clear(input);
    await user.type(input, "/tmp/does-not-exist");

    const saveButton = screen.getByRole("button", { name: /Save & Test/i });
    await user.click(saveButton);

    const errorText = await screen.findByText("binary not found");
    const body = screen.getByTestId("antigravity-cli-provider-card-body");
    expect(body).toContainElement(errorText);
  });

  it("does not render the body wrapper in the non-compact onboarding layout", async () => {
    render(<AntigravityCliProviderCard authenticated />);

    const card = await screen.findByTestId("antigravity-cli-provider-card");
    expect(card).toHaveClass("onboarding-provider-card");
    await waitFor(() => expect(fetchAntigravityCliStatus).toHaveBeenCalled());
    expect(screen.queryByTestId("antigravity-cli-provider-card-body")).not.toBeInTheDocument();
  });
});
